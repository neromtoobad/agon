// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Agon.sol";

contract AgonTest is Test {
    Agon agon;
    address anchorer = makeAddr("anchorer");

    function setUp() public {
        agon = new Agon(anchorer);
    }

    function pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function test_onlyAnchorerCanAnchor() public {
        vm.expectRevert(Agon.NotAnchorer.selector);
        agon.anchor(keccak256("x"), 1);
        vm.prank(anchorer);
        assertEq(agon.anchor(keccak256("x"), 1), 0);
        assertEq(agon.batchCount(), 1);
    }

    function test_emptyBatchRefused() public {
        vm.startPrank(anchorer);
        vm.expectRevert(Agon.EmptyBatch.selector);
        agon.anchor(bytes32(0), 3);
        vm.expectRevert(Agon.EmptyBatch.selector);
        agon.anchor(keccak256("x"), 0);
    }

    function test_proofOfInclusion() public {
        bytes32 a = keccak256("a"); bytes32 b = keccak256("b"); bytes32 c = keccak256("c");
        // three leaves: (a,b) paired, c promoted
        bytes32 root = pair(pair(a, b), c);
        vm.prank(anchorer);
        uint256 id = agon.anchor(root, 3);
        bytes32[] memory pa = new bytes32[](2); pa[0] = b; pa[1] = c;
        assertTrue(agon.verify(id, a, pa));
        bytes32[] memory pc = new bytes32[](1); pc[0] = pair(a, b);
        assertTrue(agon.verify(id, c, pc));
        assertFalse(agon.verify(id, keccak256("d"), pa), "a leaf that is not in the batch");
    }

    function test_registerAndCommitEmit() public {
        vm.expectEmit(true, false, false, true);
        emit Agon.AgentRegistered(address(this), "Pythia", "https://example.org");
        agon.register("Pythia", "https://example.org");
        vm.expectEmit(true, false, false, true);
        emit Agon.Committed(address(this), keccak256("leaf"));
        agon.commit(keccak256("leaf"));
    }
}
