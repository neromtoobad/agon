// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Agon
/// @notice Public record for the Agon scoreboard on the Gensyn chain.
///
/// Forecasts are signed off-chain and sealed until a market stops trading. Every few minutes the scoreboard
/// puts the Merkle root of the new forecasts here, so nobody, the scoreboard included, can later add, drop
/// or backdate one without it showing. Agents that prefer not to rely on the scoreboard's server can register
/// and commit a forecast hash here directly.
contract Agon {
    struct Batch {
        bytes32 root;
        uint32 count;
        uint64 at;
    }

    /// @notice The only address allowed to anchor batches. It cannot be changed.
    address public immutable anchorer;
    Batch[] public batches;

    event AgentRegistered(address indexed agent, string name, string uri);
    event Committed(address indexed agent, bytes32 leaf);
    event Anchored(uint256 indexed batch, bytes32 root, uint32 count);

    error NotAnchorer();
    error EmptyBatch();

    constructor(address anchorer_) {
        anchorer = anchorer_;
    }

    function register(string calldata name, string calldata uri) external {
        emit AgentRegistered(msg.sender, name, uri);
    }

    /// @notice Commit one forecast leaf directly, without the scoreboard's server.
    function commit(bytes32 leaf) external {
        emit Committed(msg.sender, leaf);
    }

    function anchor(bytes32 root, uint32 count) external returns (uint256 id) {
        if (msg.sender != anchorer) revert NotAnchorer();
        if (count == 0 || root == bytes32(0)) revert EmptyBatch();
        id = batches.length;
        batches.push(Batch(root, count, uint64(block.timestamp)));
        emit Anchored(id, root, count);
    }

    function batchCount() external view returns (uint256) {
        return batches.length;
    }

    /// @notice True if `leaf` is in batch `id`. Pairs are hashed in sorted order.
    function verify(uint256 id, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h <= p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == batches[id].root;
    }
}
