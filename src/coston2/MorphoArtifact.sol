// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.19;

// Exists solely to make forge compile Morpho Blue's artifact.
//
// Two constraints collide. Forge only compiles files under lib/ that something imports, so
// without this the `Morpho.sol:Morpho` artifact never exists and `deployCode` fails. And
// Morpho pins `pragma solidity 0.8.19` exactly, so a `^0.8.26` script cannot import it
// directly: no single compiler satisfies both pragmas.
//
// This file is 0.8.19, imports Morpho, and is never itself deployed. The deploy script then
// reaches the compiled artifact through `deployCode`, which is version-agnostic because it
// works on bytecode rather than source.
//
// Morpho Blue is vendored as a git submodule rather than copied, so its GPL-2.0-or-later
// licence stays with its own code.
import {Morpho} from "morpho-blue/Morpho.sol";
