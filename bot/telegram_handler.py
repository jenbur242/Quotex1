"""
Telegram integration for signal reception.

Supported channel formats:

  FORMAT: "sticker"  (2 messages — pair text then direction sticker)
    Msg 1: "📆 Pair: USD/BRL OTC\n🔥 Timeframe: 1️⃣ MINUTE:"
    Msg 2: UP sticker or DOWN sticker
    → Trades immediately when sticker arrives.

  FORMAT: "onyx"  (single message with all fields)
    ══════════════════
    🤖 ONYX AI BOT SIGNAL ⚡
    ══════════════════
    💎 Timezone  : UTC +5:30
    📊 Pair      : USDBDT - OTC
    📈 Timeframe : M1
    ⏰ Entry     : 23:33
    ➡️ Direction : CALL
    ══════════════════
    → Waits until Entry time (timezone-adjusted) then trades.

Multiple channels can be enabled simultaneously via telegram.channels in config.json.
"""

import asyncio
import logging
import re
import os
import json
from datetime import datetime
import pytz
from typing import Optional, Dict, Any, List
from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.utils import get_peer_id
from telethon.tl.types import Channel, Chat
from .quotex_handler import QuotexHandler
from .config import Config, ChannelConfig

SIGNAL_TIMEOUT = 30              # seconds — max gap between sticker-format pair msg and sticker
PENDING_SIGNALS_FILE = "pending_signals.json"


class SignalParser:
    """
    Parses both channel formats.
    Stateful only for the sticker format (stores pending pair between 2 messages).
    """

    def __init__(self, config: Config):
        self.logger = logging.getLogger(__name__)
        self.config = config
        # Sticker-format state
        self._pending_pair:   Optional[str]   = None
        self._pending_expiry: Optional[str]   = None
        self._pending_at:     Optional[float] = None

    # ── Sticker format ────────────────────────────────────────

    def try_parse_pair_message(self, text: str) -> bool:
        """
        Step 1 of sticker format: parse pair + expiry from text, store as pending.
        Returns True if the message was a valid signal message.
        """
        m = re.search(
            # Handles both dash-separated ("USD/BRL - OTC") and space-separated ("USD/BRL OTC")
            r'Pair\s*[:\-]\s*([A-Z]{2,6}/[A-Z]{2,6}|[A-Z]{4,8})\s*(?:-\s*)?(OTC)?',
            text, re.IGNORECASE
        )
        if not m:
            return False

        raw   = m.group(1).replace('/', '').upper()
        asset = raw + ('-OTC' if m.group(2) else '')

        self._pending_pair   = asset
        self._pending_expiry = "00:01:00"   # sticker format is always 1-minute trades
        self._pending_at     = datetime.now(pytz.utc).timestamp()
        self.logger.info(f"[sticker] Pair stored -> {asset}  expiry: 00:01:00  (waiting for sticker)")
        return True

    def parse_sticker(self, sticker_id: int) -> Optional[Dict[str, Any]]:
        """
        Step 2 of sticker format: match sticker ID → direction, combine with pending pair.
        """
        up_id   = self.config.telegram.sticker_up_id
        down_id = self.config.telegram.sticker_down_id

        if sticker_id == up_id:
            direction = "call"
        elif sticker_id == down_id:
            direction = "put"
        else:
            self.logger.debug(f"Unknown sticker id={sticker_id} — ignored.")
            return None

        if self._pending_pair is None:
            self.logger.warning("[sticker] Sticker received but no pair is pending — ignored.")
            return None

        age = datetime.now(pytz.utc).timestamp() - self._pending_at
        if age > SIGNAL_TIMEOUT:
            self.logger.warning(
                f"[sticker] Sticker arrived {age:.0f}s after pair (limit {SIGNAL_TIMEOUT}s) — ignored."
            )
            self._clear_sticker_state()
            return None

        signal = {
            'type':      'trade',
            'asset':     self._pending_pair,
            'direction': direction,
            'expiry':    self._pending_expiry,
            'entry_time': None,
            'timezone':   None,
            'parsed_at': datetime.now().isoformat(),
        }
        self.logger.info(
            f"[sticker] Signal complete -> {self._pending_pair} {direction.upper()}  "
            f"expiry: {self._pending_expiry}  ({age:.1f}s gap)"
        )
        self._clear_sticker_state()
        return signal

    def _clear_sticker_state(self):
        self._pending_pair   = None
        self._pending_expiry = None
        self._pending_at     = None

    # ── Onyx format ───────────────────────────────────────────

    def parse_onyx_signal(self, text: str) -> Optional[Dict[str, Any]]:
        """
        Parse a single-message Onyx AI Bot signal.
        Required fields: Pair + Direction.
        Optional: Timeframe, Entry, Timezone.
        """
        pair_m = re.search(
            # Handles both "USDBDT - OTC" and "USDBDT OTC" (space or dash before OTC)
            r'Pair\s*:\s*([A-Z]{3,6})\s*(?:-\s*)?(OTC)?',
            text, re.IGNORECASE
        )
        dir_m = re.search(
            r'Direction\s*:\s*(CALL|PUT|UP|DOWN|BUY|SELL)',
            text, re.IGNORECASE
        )
        if not (pair_m and dir_m):
            return None

        # Asset
        pair  = pair_m.group(1).upper()
        otc   = bool(pair_m.group(2))
        asset = pair + ('-OTC' if otc else '')

        # Direction
        raw_dir   = dir_m.group(1).upper()
        direction = "call" if raw_dir in ("CALL", "UP", "BUY") else "put"

        # Expiry from Timeframe field: M1 → 00:01:00, M5 → 00:05:00, etc.
        expiry = "00:01:00"
        tf_m = re.search(r'Timeframe\s*:\s*M(\d+)', text, re.IGNORECASE)
        if tf_m:
            expiry = f"00:{int(tf_m.group(1)):02d}:00"

        # Entry time (HH:MM or HH:MM:SS)
        entry_time = None
        entry_m = re.search(r'Entry\s*:\s*(\d{1,2}:\d{2}(?::\d{2})?)', text, re.IGNORECASE)
        if entry_m:
            t = entry_m.group(1)
            entry_time = t if t.count(':') == 2 else t + ":00"

        # Timezone (e.g. "UTC +5:30", "UTC+5:30", "+5:30")
        timezone_str = None
        tz_m = re.search(r'Timezone\s*:\s*(UTC\s*[+-]\s*\d{1,2}:\d{2}|[+-]\d{1,2}:\d{2})', text, re.IGNORECASE)
        if tz_m:
            timezone_str = tz_m.group(1).replace(' ', '')

        signal = {
            'type':       'trade',
            'asset':      asset,
            'direction':  direction,
            'expiry':     expiry,
            'entry_time': entry_time,
            'timezone':   timezone_str,
            'parsed_at':  datetime.now().isoformat(),
        }
        self.logger.info(
            f"[onyx] Signal -> {asset} {direction.upper()}  "
            f"entry: {entry_time} ({timezone_str})  expiry: {expiry}"
        )
        return signal


class SignalExecutor:
    """Executes trade signals. Immediate for sticker format, time-scheduled for onyx."""

    def __init__(self, config: Config, quotex_handler: QuotexHandler):
        self.config          = config
        self.quotex_handler  = quotex_handler
        self.logger          = logging.getLogger(__name__)
        self.pending_signals: Dict[str, Any] = {}

    async def schedule_signal(self, signal: Dict[str, Any]) -> bool:
        try:
            if signal['type'] == 'trade':
                sid = f"trade_{signal['asset']}_{signal['direction']}_{signal['parsed_at']}"
                self.pending_signals[sid] = {**signal, 'executed': False}
                await self._execute(sid)
                return True
            return False
        except Exception as e:
            self.logger.error(f"Error scheduling signal: {e}")
            return False

    async def _execute(self, sid: str):
        try:
            signal = self.pending_signals.get(sid)
            if not signal or signal.get('executed'):
                return

            asset     = signal['asset']
            direction = signal['direction']
            expiry    = signal.get('expiry')

            # ── Step 1: Select the pair immediately ───────────────
            try:
                await self.quotex_handler.select_asset(self.quotex_handler.driver, asset)
            except Exception as e:
                self.logger.error(f"Could not select asset {asset}: {e}")

            # ── Step 1b: For timed (onyx) signals, work out the wait first ──
            # The timezone MUST come from the signal — there is no UTC fallback,
            # so a trade is never fired at the wrong moment on an assumed zone.
            wait_secs = None
            if signal.get('entry_time'):
                wait_secs = self._calc_wait(signal['entry_time'], signal.get('timezone'))
                if wait_secs is None:
                    self.logger.error(
                        f"Skipping {asset} {direction.upper()} — entry time "
                        f"'{signal['entry_time']}' cannot be scheduled "
                        f"(missing or invalid timezone in signal)."
                    )
                    return
                if wait_secs < -30:
                    self.logger.warning(
                        f"Entry time already passed by {abs(wait_secs):.0f}s — skipping."
                    )
                    return

            # ── Step 1c: Pre-set amount + expiry for timed signals ─
            # Everything is configured upfront; at entry time only the button is clicked.
            pre_configured_amount = None
            if signal.get('entry_time'):
                try:
                    pre_configured_amount = await self.quotex_handler.pre_configure_trade(expiry)
                except Exception as e:
                    self.logger.error(f"Pre-configure failed — will retry at entry time: {e}")

            # ── Step 2: Wait until 3 s before entry time (onyx format) ──────
            if signal.get('entry_time'):
                # Place 3 seconds early so the trade is live at the exact entry time
                sleep_time = max(0.0, wait_secs - 3)
                if sleep_time > 0:
                    self.logger.info(
                        f"Pair {asset} selected. "
                        f"Waiting {sleep_time:.1f}s "
                        f"(entering 3s before {signal['entry_time']})..."
                    )
                    await asyncio.sleep(sleep_time)
                self.logger.info(
                    f"Placing trade now — 3s before entry {signal['entry_time']}."
                )

            # ── Step 4: Place trade ───────────────────────────────
            self.logger.info(f"Executing: {asset} {direction.upper()}")
            success = await self.quotex_handler.perform_trade(
                asset, direction, expiry=expiry,
                pre_configured_amount=pre_configured_amount,
            )

            if success:
                signal['executed'] = True
                self.logger.info(f"Trade executed: {asset} {direction.upper()}")
                logging.getLogger('trades').info(
                    f"QUOTEX_TRADE_EXECUTED | {json.dumps(signal)}"
                )
            else:
                self.logger.error("Trade execution failed.")

        except Exception as e:
            self.logger.error(f"Error executing trade {sid}: {e}")
        finally:
            self.pending_signals.pop(sid, None)

    def _calc_wait(self, entry_time_str: str, timezone_str: Optional[str]) -> Optional[float]:
        """
        Returns seconds until entry time. Negative means it already passed.

        The timezone MUST be supplied by the signal — there is NO UTC fallback.
        Returns None when the timezone is missing/unparseable or the entry time
        cannot be parsed; the caller then skips the trade so it is never fired at
        the wrong moment based on an assumed timezone.
        """
        if not timezone_str:
            self.logger.error(
                f"No timezone in signal for entry '{entry_time_str}' — "
                f"cannot schedule (UTC fallback removed). Skipping."
            )
            return None

        try:
            tz_clean = timezone_str.replace(' ', '')
            if tz_clean.upper().startswith('UTC'):
                tz_clean = tz_clean[3:]
            m = re.match(r'^([+-])(\d{1,2}):(\d{2})$', tz_clean)
            if not m:
                self.logger.error(
                    f"Unparseable timezone '{timezone_str}' for entry "
                    f"'{entry_time_str}' — skipping."
                )
                return None
            sign       = 1 if m.group(1) == '+' else -1
            offset_min = sign * (int(m.group(2)) * 60 + int(m.group(3)))
            signal_tz  = pytz.FixedOffset(offset_min)

            # Build the entry instant on TODAY'S DATE IN THE SIGNAL'S TIMEZONE.
            # Using UTC's date is wrong: when the UTC date differs from the
            # signal-tz date (e.g. early-morning IST is still the previous UTC
            # day), the entry lands ~24h off — the "passed by 86248s" bug.
            now_tz = datetime.now(signal_tz)
            t      = datetime.strptime(entry_time_str, '%H:%M:%S')
            entry  = now_tz.replace(
                hour=t.hour, minute=t.minute, second=t.second, microsecond=0
            )

            delta = (entry - now_tz).total_seconds()
            # Near-midnight wrap: an entry that looks more than 12h in the past is
            # really the next day's occurrence (e.g. 00:05 entry sent at 23:58).
            if delta < -43200:
                delta += 86400
            return delta

        except Exception as e:
            self.logger.error(f"Could not calculate wait time for '{entry_time_str}': {e}")
            return None


class TelegramHandler:
    """Complete Telegram integration — monitors multiple channels simultaneously."""

    def __init__(self, config):
        self.config          = config
        self.logger          = logging.getLogger(__name__)
        self.client          = None
        self.parser          = SignalParser(self.config)
        self.executor        = None
        self.signal_callback = None
        self.session_string  = None
        self.api_id          = self.config.telegram.api_id
        self.api_hash        = self.config.telegram.api_hash
        self.phone_number    = None

    async def initialize(self, quotex_handler: QuotexHandler):
        try:
            self.logger.info("Initializing Telegram client...")
            self._load_session()

            if not self.phone_number:
                print("\n" + "=" * 60)
                print("    TELEGRAM LOGIN REQUIRED")
                print("=" * 60)
                print("Get API credentials from: https://my.telegram.org/apps\n")
                self.phone_number = input("Enter your phone number (with country code): ").strip()

            session = StringSession(self.session_string) if self.session_string else StringSession()
            self.client = TelegramClient(session, self.api_id, self.api_hash)
            await self.client.start(phone=self.phone_number)

            self.session_string = self.client.session.save()
            self._save_session()
            await self._list_chats()

            self.executor = SignalExecutor(self.config, quotex_handler)
            self.logger.info("Telegram client initialized successfully")
            return True

        except Exception as e:
            self.logger.error(f"Failed to initialize Telegram client: {e}")
            return False

    def _load_session(self):
        try:
            session_file = f"{self.config.telegram.session_name}.json"
            if os.path.exists(session_file):
                with open(session_file, 'r') as f:
                    data = json.load(f)
                self.session_string = data.get('session_string')
                self.phone_number   = data.get('phone_number')
                self.logger.info("Telegram session loaded")
        except Exception as e:
            self.logger.debug(f"Could not load session: {e}")

    def _save_session(self):
        try:
            session_file = f"{self.config.telegram.session_name}.json"
            with open(session_file, 'w') as f:
                json.dump({
                    'session_string': self.session_string,
                    'phone_number':   self.phone_number,
                    'saved_at':       datetime.now().isoformat(),
                }, f)
            self.logger.info("Telegram session saved")
        except Exception as e:
            self.logger.error(f"Could not save session: {e}")

    async def _list_chats(self):
        try:
            dialogs = await self.client.get_dialogs(limit=None)
            groups  = [d for d in dialogs if isinstance(d.entity, (Channel, Chat))]
            print("\n" + "=" * 65)
            print("  AVAILABLE GROUPS & CHANNELS")
            print("=" * 65)
            print(f"  {'TYPE':<12} {'ID (use in config.json)':<25} NAME")
            print("  " + "-" * 62)
            for d in groups:
                pid   = get_peer_id(d.entity)
                etype = "Channel" if isinstance(d.entity, Channel) else "Group"
                title = getattr(d.entity, 'title', 'Unknown')
                print(f"  {etype:<12} {str(pid):<25} {title}")
                self.logger.info(f"Chat: {etype} | {pid} | {title}")
            print("=" * 65)
            enabled = [c for c in self.config.telegram.channels if c.enabled]
            print(f"  Enabled channels: {[c.identifier for c in enabled]}")
            print("=" * 65 + "\n")
        except Exception as e:
            self.logger.error(f"Error listing chats: {e}")

    async def _resolve_channel(self, identifier):
        """Resolve a channel identifier (name, @username, or numeric ID) to a Telethon entity."""
        is_plain = isinstance(identifier, str) and ' ' in identifier.strip()

        if not is_plain:
            try:
                return await self.client.get_entity(identifier)
            except Exception:
                pass
            if isinstance(identifier, str) and identifier.strip().lstrip('-').isdigit():
                try:
                    return await self.client.get_entity(int(identifier.strip()))
                except Exception:
                    pass

        dialogs  = await self.client.get_dialogs(limit=None)
        id_lower = str(identifier).strip().lower()
        for d in dialogs:
            title = getattr(d.entity, 'title', '') or getattr(d.entity, 'first_name', '') or ''
            if title.strip().lower() == id_lower:
                self.logger.info(f"Found '{identifier}' (ID: {get_peer_id(d.entity)})")
                return d.entity

        raise ValueError(f"Could not find channel/group '{identifier}'.")

    async def start_monitoring(self, signal_callback):
        try:
            if not self.client:
                raise Exception("Telegram client not initialized")

            self.signal_callback = signal_callback

            enabled: List[ChannelConfig] = [
                c for c in self.config.telegram.channels if c.enabled
            ]
            if not enabled:
                self.logger.error("No channels enabled. Set enabled=true in telegram.channels.")
                return

            watch_ids: List[int] = []

            for ch in enabled:
                try:
                    entity = await self._resolve_channel(ch.identifier)
                    watch_ids.append(entity.id)
                    self.logger.info(
                        f"Watching: {getattr(entity, 'title', ch.identifier)} (ID: {entity.id})"
                    )
                    async for msg in self.client.iter_messages(entity, limit=1):
                        preview = msg.text[:80] if msg.text else '[sticker/media]'
                        self.logger.info(f"  Last message (ID: {msg.id}): '{preview}'")
                except Exception as e:
                    self.logger.error(f"Could not resolve channel '{ch.identifier}': {e}")

            if not watch_ids:
                self.logger.error("No channels could be resolved. Check config.")
                return

            @self.client.on(events.NewMessage(chats=watch_ids))
            async def on_message(event):
                await self._handle_message(event)

            await self.client.run_until_disconnected()

        except Exception as e:
            self.logger.error(f"Error monitoring channels: {e}")

    async def _handle_message(self, event):
        """
        Auto-detect signal format from message content:
          - Sticker                        → direction for pending pair (2-msg format step 2)
          - Text with Direction: field     → complete Onyx signal (1 message, waits for entry time)
          - Text with Pair: but no Direction → pair info only (2-msg format step 1, waits for sticker)
        """
        msg = event.message
        self.logger.info(f"New message ID: {msg.id} from chat {event.chat_id}")
        try:
            # ── Sticker → direction ───────────────────────────────
            if msg.sticker:
                self.logger.info(f"Sticker id={msg.sticker.id}")
                signal = self.parser.parse_sticker(msg.sticker.id)
                if signal and self.signal_callback:
                    await self.signal_callback(signal)
                return

            if not msg.text:
                return

            text = msg.text
            self.logger.info(f"Text: '{text[:120]}'")

            # ── Complete signal (Onyx) — has both Pair + Direction ─
            if re.search(r'Direction\s*:', text, re.IGNORECASE):
                signal = self.parser.parse_onyx_signal(text)
                if signal and self.signal_callback:
                    await self.signal_callback(signal)

            # ── Pair-only message — step 1 of 2-message format ────
            elif re.search(r'Pair\s*[:\-]', text, re.IGNORECASE):
                self.parser.try_parse_pair_message(text)

            # ── Unrecognised text — ignore ─────────────────────────

        except Exception as e:
            self.logger.error(f"Error handling message {msg.id}: {e}")

    async def disconnect(self):
        try:
            if self.client:
                await self.client.disconnect()
                self.logger.info("Telegram client disconnected")
        except Exception as e:
            self.logger.error(f"Error disconnecting: {e}")

    async def test_connection(self) -> bool:
        try:
            if not self.client:
                return False
            me = await self.client.get_me()
            self.logger.info(f"Connected as: {me.first_name}")
            return True
        except Exception as e:
            self.logger.error(f"Connection failed: {e}")
            return False
