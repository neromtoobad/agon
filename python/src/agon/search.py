"""Keyword search over markets. Small and dependency-free: word matches in the question count most, then
outcomes, then the rules; prefixes count ("elect" finds "election"); ties go to the market that closes first."""

from __future__ import annotations

import math
import re

from .models import Market

_WORD = re.compile(r"[a-z0-9$%.]+")
_STOP = {"the", "a", "an", "of", "in", "on", "by", "to", "will", "be", "is", "for", "and", "or", "at", "before", "after"}


def _words(text: str | None) -> list[str]:
    return [w.strip(".") for w in _WORD.findall((text or "").lower()) if w.strip(".") and w not in _STOP]


def score(m: Market, terms: list[str]) -> float:
    fields = ((_words(m.question), 3.0), (_words(" ".join(m.outcomes)), 2.0), (_words(m.rules), 1.0))
    total = 0.0
    for t in terms:
        best = 0.0
        for words, weight in fields:
            if t in words:
                best = max(best, weight)
            elif any(w.startswith(t) for w in words) and len(t) >= 3:
                best = max(best, weight * 0.6)
        total += best
    return total


def rank(markets: list[Market], query: str) -> list[Market]:
    terms = _words(query)
    if not terms:
        return markets
    scored = [(score(m, terms), m) for m in markets]
    scored = [(s, m) for s, m in scored if s > 0]
    scored.sort(key=lambda x: (-x[0], x[1].trading_closes_at.timestamp() if x[1].trading_closes_at else math.inf))
    return [m for _, m in scored]
