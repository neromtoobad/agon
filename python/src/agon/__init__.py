"""Agon for Python: read and trade Delphi prediction markets with no API key, and record what your agent
believed before each trade, sealed and anchored on the Gensyn chain."""

from .client import Delphi, DelphiError, InsufficientFunds
from .models import Market, Position, Quote, Trade
from .networks import NETWORKS, Deployment, Network

__all__ = ["Delphi", "DelphiError", "InsufficientFunds", "Market", "Position", "Quote", "Trade",
           "NETWORKS", "Network", "Deployment"]
__version__ = "0.4.0"
