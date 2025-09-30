# scheduler.py
import asyncio
from datetime import datetime, timedelta, timezone

from config import RAFFLE_ROUND_MINUTES, RAFFLE_BREAK_MINUTES
from db import get_conn, create_round, mark_round_closed
from payouts import settle_and_payout

async def raffle_loop():
    """Simple round → close → payout → break loop."""
    while True:
        try:
            conn = get_conn()

            now = datetime.now(timezone.utc)
            opens_at = now
            closes_at = now + timedelta(minutes=RAFFLE_ROUND_MINUTES)

            round_id = create_round(conn, opens_at, closes_at)  # "R1234"
            print(f"[RAFFLE] Opened {round_id} {opens_at} → {closes_at}")

            # wait until close time (wake every 5s so we can exit fast on crash)
            while datetime.now(timezone.utc) < closes_at:
                await asyncio.sleep(5)

            mark_round_closed(conn, round_id)
            print(f"[RAFFLE] Closing {round_id} — settling")

            try:
                result = settle_and_payout(conn, round_id)
                print(f"[RAFFLE] {round_id} winner {result.get('winner')} pot {result.get('pot')}")
            except Exception as e:
                print(f"[RAFFLE] payout error {e}")

            # break between rounds
            await asyncio.sleep(max(0, RAFFLE_BREAK_MINUTES * 60))
        except Exception as e:
            print(f"[RAFFLE] loop error {e}")
            await asyncio.sleep(5)  # backoff