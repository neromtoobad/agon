// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IDelphiGateway {
    function buyExactOut(address marketProxy, uint256 outcomeIdx, uint256 sharesOut, uint256 maxTokensIn)
        external
        returns (uint256 tokensIn, uint256 outcomeNewExp, uint256 newExpSum);
    function TOKEN() external view returns (address);
}

interface IDelphiMarket {
    function transfer(address receiver, uint256 id, uint256 amount) external returns (bool);
}

/// @title Mandate
/// @notice Lets a person allow one agent to place Delphi bets with their money, inside limits the chain enforces.
///
/// The contract never holds anyone's funds between transactions. A bet pulls collateral from the person's own
/// wallet, buys on Delphi, and sends the outcome shares straight back to that wallet, all in one transaction.
/// The person redeems winnings on Delphi themselves. There is no owner, no fee and no upgrade path.
///
/// Three independent limits apply: this contract's caps, the expiry, and the ERC-20 allowance the person gave
/// this contract. Setting that allowance to zero, or calling `revoke`, stops the agent immediately.
contract Mandate {
    struct Terms {
        address gateway;      // the Delphi gateway the agent may trade through, chosen by the person
        uint128 perBet;       // most collateral one bet may cost
        uint128 perDay;       // most collateral per rolling UTC day
        uint128 total;        // most collateral over the mandate's life
        uint128 spent;
        uint128 spentToday;
        uint64 day;           // UTC day number `spentToday` refers to
        uint64 expiry;        // unix seconds; bets after this revert
    }

    /// person => agent => terms
    mapping(address => mapping(address => Terms)) public mandates;

    event Granted(address indexed person, address indexed agent, address gateway, uint128 perBet, uint128 perDay, uint128 total, uint64 expiry);
    event Revoked(address indexed person, address indexed agent);
    event Bet(address indexed person, address indexed agent, address indexed market, uint256 outcomeIdx, uint256 sharesOut, uint256 cost);

    error NoMandate();
    error Expired();
    error OverPerBet(uint256 cost, uint256 cap);
    error OverPerDay(uint256 wouldSpend, uint256 cap);
    error OverTotal(uint256 wouldSpend, uint256 cap);

    function grant(address agent, address gateway, uint128 perBet, uint128 perDay, uint128 total, uint64 expiry) external {
        mandates[msg.sender][agent] = Terms(gateway, perBet, perDay, total, 0, 0, 0, expiry);
        emit Granted(msg.sender, agent, gateway, perBet, perDay, total, expiry);
    }

    function revoke(address agent) external {
        delete mandates[msg.sender][agent];
        emit Revoked(msg.sender, agent);
    }

    /// @notice Called by the agent. Buys exactly `sharesOut` of `outcomeIdx` for `person`, costing at most `maxCost`.
    function bet(address person, address market, uint256 outcomeIdx, uint256 sharesOut, uint256 maxCost) external returns (uint256 cost) {
        Terms storage t = mandates[person][msg.sender];
        if (t.gateway == address(0)) revert NoMandate();
        if (block.timestamp > t.expiry) revert Expired();

        IERC20 token = IERC20(IDelphiGateway(t.gateway).TOKEN());
        // Pull the most this bet may cost, buy, then hand back what was not needed.
        token.transferFrom(person, address(this), maxCost);
        token.approve(market, maxCost);
        (cost,,) = IDelphiGateway(t.gateway).buyExactOut(market, outcomeIdx, sharesOut, maxCost);
        token.approve(market, 0);
        if (cost < maxCost) token.transfer(person, maxCost - cost);

        if (cost > t.perBet) revert OverPerBet(cost, t.perBet);
        uint64 today = uint64(block.timestamp / 1 days);
        uint128 todaySoFar = t.day == today ? t.spentToday : 0;
        if (todaySoFar + cost > t.perDay) revert OverPerDay(todaySoFar + cost, t.perDay);
        if (t.spent + cost > t.total) revert OverTotal(t.spent + cost, t.total);
        t.day = today;
        t.spentToday = todaySoFar + uint128(cost);
        t.spent += uint128(cost);

        // The shares go to the person, who holds and redeems them on Delphi directly.
        IDelphiMarket(market).transfer(person, outcomeIdx, sharesOut);
        emit Bet(person, msg.sender, market, outcomeIdx, sharesOut, cost);
    }
}
