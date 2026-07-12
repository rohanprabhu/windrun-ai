import { createAddresses, type AddressResources } from "./addresses";
import {
  createRuntimeIdentities,
  type RuntimeIdentityResources,
} from "./identities";
import type { ProjectBundle } from "./projects";
import { createRegistries, type RegistryResources } from "./registries";

export interface FoundationCoreResources
  extends RegistryResources,
    AddressResources,
    RuntimeIdentityResources {}

export function createFoundationCoreResources(args: {
  staging: ProjectBundle;
  production: ProjectBundle;
}): FoundationCoreResources {
  return {
    ...createRegistries(args),
    ...createAddresses(args),
    ...createRuntimeIdentities(args),
  };
}
