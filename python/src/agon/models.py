"""Plain data objects returned by the client. Money is in USD (the collateral token), shares are decimal numbers."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

STATUSES = ("open", "awaiting_settlement", "settled", "expired", "failed")


def ts(seconds: int | None) -> Optional[datetime]:
    return datetime.fromtimestamp(seconds, tz=timezone.utc) if seconds else None


def _jsonable(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    return v


class _Dict:
    def to_dict(self) -> dict:
        return _jsonable(asdict(self))  # type: ignore[arg-type]


@dataclass
class Market(_Dict):
    address: str
    deployment: str                    # "lmsr" | "dpm" | "dpm-legacy"
    mechanism: str                     # "lmsr" | "dpm"
    status: str                        # one of STATUSES
    question: Optional[str]
    outcomes: list[str]
    probabilities: list[float]         # implied probability per outcome, sums to ~1
    prices: list[float]                # USD cost of one more share, per outcome (spot)
    trading_closes_at: Optional[datetime]
    settlement_deadline: Optional[datetime]
    earliest_resolve_at: Optional[datetime] = None
    winning_outcome: Optional[int] = None
    pool_usd: Optional[float] = None
    trading_fee: Optional[float] = None
    rules: Optional[str] = None        # what the AI judge is told to check
    sources: list[str] = field(default_factory=list)
    judge_model: Optional[str] = None
    metadata_uri: Optional[str] = None
    metadata_verified: Optional[bool] = None   # True when the rules file matches its on-chain hash
    url: Optional[str] = None
    gateway: Optional[str] = None
    raw_metadata: Optional[dict] = field(default=None, repr=False)

    @property
    def is_open(self) -> bool:
        return self.status == "open"

    def outcome_index(self, outcome: int | str) -> int:
        """Accept an index or a label ("Yes", "no", ...)."""
        if isinstance(outcome, int) or (isinstance(outcome, str) and outcome.isdigit()):
            i = int(outcome)
            if not 0 <= i < len(self.outcomes or self.probabilities):
                raise ValueError(f"outcome {i} out of range for {self.address}")
            return i
        labels = [o.lower().strip() for o in self.outcomes]
        try:
            return labels.index(str(outcome).lower().strip())
        except ValueError:
            raise ValueError(f"{outcome!r} is not an outcome of this market; outcomes are {self.outcomes}") from None

    def summary(self) -> str:
        odds = ", ".join(f"{o} {p:.0%}" for o, p in zip(self.outcomes, self.probabilities))
        close = self.trading_closes_at.strftime("%Y-%m-%d %H:%M UTC") if self.trading_closes_at else "?"
        return f"{self.question}  [{odds}]  {self.status}, trading closes {close}"


@dataclass
class Quote(_Dict):
    market: str
    outcome: int
    outcome_label: Optional[str]
    side: str                          # "buy" | "sell"
    shares: float
    usd: float                         # cost for a buy, proceeds for a sell (fees included)
    average_price: Optional[float]
    probability_before: Optional[float]
    probability_after: Optional[float] = None
    shares_raw: int = 0
    usd_raw: int = 0


@dataclass
class Trade(_Dict):
    market: str
    outcome: int
    outcome_label: Optional[str]
    side: str
    shares: float
    usd: float
    tx_hash: str
    explorer_url: str
    approval_tx: Optional[str] = None
    record: Optional[dict] = None      # the sealed entry logged before this trade (record=True), or why it wasn't


@dataclass
class Position(_Dict):
    market: str
    question: Optional[str]
    outcome: int
    outcome_label: Optional[str]
    shares: float
    probability: Optional[float]
    value_usd: Optional[float]          # shares x current probability (open markets) or payout (settled)
    status: str
    action: Optional[str] = None        # "redeem" | "liquidate" | None
    claimable_usd: Optional[float] = None
