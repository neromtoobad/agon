"""Where Delphi lives on each network.

Delphi has shipped several generations of contracts. Each has its own factory (which creates markets) and gateway
(which every trade, quote and settlement goes through). A market belongs to exactly one generation for life, so
every call has to be sent to the right gateway. The official TypeScript SDK 2.1.0 knows the two pari-mutuel
generations; the two LMSR ones, including the one that carries live trading on mainnet since September 2026, are
listed here too.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Deployment:
    name: str          # short label, e.g. "lmsr"
    kind: str          # "lmsr" | "lmsr_v1" | "dpm" | "dpm_legacy" (selects the ABI)
    factory: str
    gateway: str
    note: str = ""


@dataclass(frozen=True)
class Network:
    name: str
    chain_id: int
    rpc_url: str
    token: str                      # USDC (or the competition token)
    token_decimals: int
    multicall3: str
    explorer_url: str
    app_url: str
    deployments: tuple[Deployment, ...] = field(default_factory=tuple)


MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"

NETWORKS: dict[str, Network] = {
    "mainnet": Network(
        name="mainnet",
        chain_id=685689,
        rpc_url="https://gensyn-mainnet.g.alchemy.com/public",
        token="0x5b32c997211621d55a89Cc5abAF1cC21F3A6ddF5",
        token_decimals=6,
        multicall3=MULTICALL3,
        explorer_url="https://gensyn-mainnet.explorer.alchemy.com",
        app_url="https://delphi.fyi",
        deployments=(
            Deployment("lmsr", "lmsr", "0x1819a2aeEb96DA9BA1C5262A5c82B6F9c347f99c",
                       "0x7fd914D05D1FE4Fa3EC84E2Cd1D81be6CBe03747",
                       "LMSR, AI-settled. Live trading since Sep 2026. Not in SDK 2.1.0 defaults."),
            Deployment("dpm", "dpm", "0x9C73417f79a1361c6aF9Bd828343badEE1b84936",
                       "0x982a67aE92D8de361957249fB2BB4a62BCc6A8d5",
                       "Pari-mutuel, AI-settled."),
            Deployment("dpm-legacy", "dpm_legacy", "0x4596d847eA56DCf9A37944c13793Af802Fc5D1eC",
                       "0x4e4e85c52E0F414cc67eE88d0C649Ec81698d700",
                       "Pari-mutuel, creator-settled. First generation."),
            Deployment("lmsr-early", "lmsr_v1", "0x04f69113bc76f9458913568a412385E5E77ae160",
                       "0xccAfED662531272Cb65E1Cdd6bCD09bDbC2b3D18",
                       "LMSR, first version. Four markets from Sep 2026, none open. Not in SDK 2.1.0 defaults."),
        ),
    ),
    "testnet": Network(
        name="testnet",
        chain_id=685685,
        rpc_url="https://gensyn-testnet.g.alchemy.com/public",
        token="0x0724D6079b986F8e44bDafB8a09B60C0bd6A45a1",
        token_decimals=6,
        multicall3=MULTICALL3,
        explorer_url="https://gensyn-testnet.explorer.alchemy.com",
        app_url="https://testnet.delphi.fyi",
        deployments=(
            Deployment("dpm", "dpm", "0x97d2b3F0614C8189343A38094629FCE2910b727A",
                       "0x22ea355D7218Dc86b4c83732cBbd01f7Ff2332b3"),
            Deployment("dpm-legacy", "dpm_legacy", "0xd03CEC55802f0D44D844384E1144B25717315E5A",
                       "0x7b8FDBD187B0Be5e30e48B1995df574A62667147"),
        ),
    ),
    "competition-testnet": Network(
        name="competition-testnet",
        chain_id=685685,
        rpc_url="https://gensyn-testnet.g.alchemy.com/public",
        token="0x8A2d75753362Eb5D5669a2c22cbf394b26a0571F",
        token_decimals=6,
        multicall3=MULTICALL3,
        explorer_url="https://gensyn-testnet.explorer.alchemy.com",
        app_url="https://agent-competition.gensyn.ai",
        deployments=(
            Deployment("lmsr", "lmsr_v1", "0xEa9D0a78d0209916e88e363B8FDa3e23206Ff49b",
                       "0x097599c9D966fF496284b892A8F13BF885b258ef", "Agent competition."),
        ),
    ),
}


def get_network(name: str) -> Network:
    try:
        return NETWORKS[name]
    except KeyError:
        raise ValueError(f"unknown network {name!r}; choose one of {', '.join(NETWORKS)}") from None
