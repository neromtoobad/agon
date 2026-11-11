// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Mandate.sol";

interface IERC20Full { function balanceOf(address) external view returns (uint256); function approve(address, uint256) external returns (bool); }
interface IGatewayViews {
    function balanceOf(address marketProxy, address owner, uint256 outcomeIdx) external view returns (uint256);
    function quoteBuyExactOut(address marketProxy, uint256 outcomeIdx, uint256 sharesOut) external view returns (uint256, uint256, uint256);
}

/// Runs against a fork of Gensyn mainnet and the live Delphi contracts.
contract MandateForkTest is Test {
    address constant GATEWAY = 0x7fd914D05D1FE4Fa3EC84E2Cd1D81be6CBe03747; // live LMSR gateway
    address constant USDC = 0x5b32c997211621d55a89Cc5abAF1cC21F3A6ddF5;
    address constant MARKET = 0x113029Df80f151b844Aa39Ba5D0E90D27E994cac; // England v Croatia, open

    Mandate mandate;
    address person = makeAddr("person");
    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");

    function setUp() public {
        vm.createSelectFork(vm.envString("GENSYN_RPC_URL"));
        mandate = new Mandate();
        deal(USDC, person, 100e6);
        vm.startPrank(person);
        IERC20Full(USDC).approve(address(mandate), 20e6);                       // wallet-level cap: $20
        mandate.grant(agent, GATEWAY, 3e6, 5e6, 10e6, uint64(block.timestamp + 7 days)); // $3 a bet, $5 a day, $10 in all
        vm.stopPrank();
    }

    function test_agentBetsWithinLimits_sharesLandInPersonsWallet() public {
        uint256 shares = 2e18; // two "Yes" shares
        (uint256 quote,,) = IGatewayViews(GATEWAY).quoteBuyExactOut(MARKET, 0, shares);
        vm.prank(agent);
        uint256 cost = mandate.bet(person, MARKET, 0, shares, 3e6);
        emit log_named_decimal_uint("quoted cost (USDC)", quote, 6);
        emit log_named_decimal_uint("actual cost (USDC)", cost, 6);
        assertEq(cost, quote);
        assertEq(IGatewayViews(GATEWAY).balanceOf(MARKET, person, 0), shares, "person holds the shares");
        assertEq(IGatewayViews(GATEWAY).balanceOf(MARKET, address(mandate), 0), 0, "contract holds no shares");
        assertEq(IERC20Full(USDC).balanceOf(address(mandate)), 0, "contract holds no money");
        assertEq(IERC20Full(USDC).balanceOf(person), 100e6 - cost, "person paid exactly the cost");
        assertEq(IERC20Full(USDC).balanceOf(agent), 0, "agent never touches the money");
    }

    function test_overPerBetCap_reverts() public {
        vm.prank(agent);
        vm.expectRevert(); // costs more than $3: the pull is capped at maxCost, so Delphi itself refuses
        mandate.bet(person, MARKET, 0, 8e18, 3e6);
        vm.prank(agent);
        vm.expectPartialRevert(Mandate.OverPerBet.selector); // and asking for a higher maxCost hits the mandate's cap
        mandate.bet(person, MARKET, 0, 8e18, 8e6);
    }

    function test_dailyCap_reverts_thenResetsNextDay() public {
        vm.prank(person);
        mandate.grant(agent, GATEWAY, 4e6, 5e6, 10e6, uint64(block.timestamp + 7 days)); // $4 a bet for this test
        vm.startPrank(agent);
        mandate.bet(person, MARKET, 0, 3e18, 4e6);          // about $2.20
        vm.expectPartialRevert(Mandate.OverPerDay.selector);
        mandate.bet(person, MARKET, 0, 4e18, 4e6);          // about $3.30 more would pass $5 for the day
        vm.warp(block.timestamp + 1 days);
        mandate.bet(person, MARKET, 1, 2e18, 3e6); // new day, allowed again
        vm.stopPrank();
    }

    function test_strangerCannotBet() public {
        vm.prank(stranger);
        vm.expectRevert(Mandate.NoMandate.selector);
        mandate.bet(person, MARKET, 0, 1e18, 3e6);
    }

    function test_revokeStopsTheAgent() public {
        vm.prank(person);
        mandate.revoke(agent);
        vm.prank(agent);
        vm.expectRevert(Mandate.NoMandate.selector);
        mandate.bet(person, MARKET, 0, 1e18, 3e6);
    }

    function test_zeroAllowanceStopsTheAgent() public {
        vm.prank(person);
        IERC20Full(USDC).approve(address(mandate), 0);
        vm.prank(agent);
        vm.expectRevert();
        mandate.bet(person, MARKET, 0, 1e18, 3e6);
    }

    function test_expiryStopsTheAgent() public {
        vm.warp(block.timestamp + 8 days);
        vm.prank(agent);
        vm.expectRevert(Mandate.Expired.selector);
        mandate.bet(person, MARKET, 0, 1e18, 3e6);
    }
}
