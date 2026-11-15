"""Low-level chain access: ABIs, a Web3 instance, and batched reads through Multicall3."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from importlib import resources
from typing import Any, Iterable, Sequence

from web3 import Web3
from web3.contract import Contract

from .networks import Network

ERC20_ABI = [
    {"type": "function", "name": "balanceOf", "stateMutability": "view",
     "inputs": [{"name": "owner", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "allowance", "stateMutability": "view",
     "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "approve", "stateMutability": "nonpayable",
     "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
]

MULTICALL3_ABI = [
    {"type": "function", "name": "aggregate3", "stateMutability": "payable",
     "inputs": [{"name": "calls", "type": "tuple[]", "components": [
         {"name": "target", "type": "address"}, {"name": "allowFailure", "type": "bool"},
         {"name": "callData", "type": "bytes"}]}],
     "outputs": [{"name": "returnData", "type": "tuple[]", "components": [
         {"name": "success", "type": "bool"}, {"name": "returnData", "type": "bytes"}]}]},
]

ABI_FILE = {"lmsr": "LmsrGateway.json", "lmsr_v1": "LmsrGatewayV1.json", "dpm": "DpmGateway.json", "dpm_legacy": "DpmGatewayLegacy.json",
            "factory": "DelphiFactory.json", "lmsr_market": "LmsrMarket.json"}


@cache
def abi(kind: str) -> list[dict]:
    """The verified ABI for a contract kind, as published on the Gensyn explorer."""
    return json.loads(resources.files("agon.abi").joinpath(ABI_FILE[kind]).read_text())


def checksum(address: str) -> str:
    return Web3.to_checksum_address(address)


def connect(network: Network, rpc_url: str | None = None, timeout: float = 45) -> Web3:
    return Web3(Web3.HTTPProvider(rpc_url or network.rpc_url, request_kwargs={"timeout": timeout}))


def _output_types(fn_abi: dict) -> list[str]:
    def t(o: dict) -> str:
        if o["type"].startswith("tuple"):
            return "(" + ",".join(t(c) for c in o["components"]) + ")" + o["type"][5:]
        return o["type"]
    return [t(o) for o in fn_abi["outputs"]]


def named(value: Any, out_abi: dict) -> Any:
    """Turn a decoded tuple into a dict keyed by the ABI's component names (recursively)."""
    if out_abi["type"] == "tuple" and isinstance(value, (tuple, list)):
        return {c["name"]: named(v, c) for v, c in zip(value, out_abi["components"])}
    return value


@dataclass
class Call:
    contract: Contract
    fn: str
    args: Sequence[Any] = ()

    def fn_abi(self) -> dict:
        n_args = len(self.args)
        for item in self.contract.abi:
            if item.get("type") == "function" and item["name"] == self.fn and len(item["inputs"]) == n_args:
                return item
        raise ValueError(f"{self.fn}/{n_args} not in ABI")

    def decode(self, data: bytes, w3: Web3) -> Any:
        fa = self.fn_abi()
        out = w3.codec.decode(_output_types(fa), data)
        out = [named(v, o) for v, o in zip(out, fa["outputs"])]
        return out[0] if len(out) == 1 else tuple(out)


class Reader:
    """Batches read calls through Multicall3, falling back to one call at a time if it is missing."""

    def __init__(self, w3: Web3, network: Network, batch_size: int = 300):
        self.w3 = w3
        self.batch_size = batch_size
        self.mc = w3.eth.contract(address=checksum(network.multicall3), abi=MULTICALL3_ABI)
        self._has_mc: bool | None = None

    def _multicall_available(self) -> bool:
        if self._has_mc is None:
            self._has_mc = len(self.w3.eth.get_code(self.mc.address)) > 0
        return self._has_mc

    def run(self, calls: Iterable[Call]) -> list[Any]:
        """Run every call; a failed call yields an Exception object in its slot instead of raising."""
        calls = list(calls)
        if not calls:
            return []
        if not self._multicall_available():
            out = []
            for c in calls:
                try:
                    out.append(getattr(c.contract.functions, c.fn)(*c.args).call())
                except Exception as e:  # noqa: BLE001
                    out.append(e)
            return out
        results: list[Any] = []
        for i in range(0, len(calls), self.batch_size):
            part = calls[i:i + self.batch_size]
            payload = [(c.contract.address, True, c.contract.encode_abi(c.fn, args=list(c.args))) for c in part]
            raw = self.mc.functions.aggregate3(payload).call()
            for c, (ok, data) in zip(part, raw):
                if not ok:
                    results.append(RuntimeError(f"{c.fn} reverted"))
                    continue
                try:
                    results.append(c.decode(data, self.w3))
                except Exception as e:  # noqa: BLE001
                    results.append(e)
        return results

    def one(self, call: Call) -> Any:
        r = self.run([call])[0]
        if isinstance(r, Exception):
            raise r
        return r
