// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FisikaExecutor} from "../src/FisikaExecutor.sol";

/// Deploys FisikaExecutor and allowlists the verified Celo venue contracts.
///   OWNER=0x… GUARDIAN=0x… forge script script/Deploy.s.sol --rpc-url $CELO_RPC_URL --broadcast --account deployer
/// The deployer becomes a temporary owner to set the allowlist, then hands ownership to OWNER (2-step: OWNER must
/// call acceptOwnership). Use a hardware wallet or multisig for OWNER; GUARDIAN can only pause.
contract Deploy is Script {
    // Celo mainnet (42220) — verified on-chain by scripts/verify-onchain.ts
    address constant SWAP_ROUTER_02 = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;
    address constant MENTO_ROUTER = 0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6;
    address constant MENTO_BROKER = 0x777A8255cA72412f0d706dc03C9D1987306B4CaD;

    function run() external returns (FisikaExecutor ex) {
        require(block.chainid == 42220, "not Celo mainnet");
        address owner = vm.envAddress("OWNER");
        address guardian = vm.envAddress("GUARDIAN");
        vm.startBroadcast();
        ex = new FisikaExecutor(msg.sender, guardian);
        address[3] memory venues = [SWAP_ROUTER_02, MENTO_ROUTER, MENTO_BROKER];
        for (uint256 i; i < venues.length; i++) {
            ex.setTarget(venues[i], true);
            ex.setSpender(venues[i], true);
        }
        if (owner != msg.sender) ex.transferOwnership(owner);
        vm.stopBroadcast();
        console2.log("FisikaExecutor", address(ex));
        console2.log("pending owner (must acceptOwnership)", owner);
    }
}
