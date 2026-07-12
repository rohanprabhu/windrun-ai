import * as digitalocean from "@pulumi/digitalocean";
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import { HOSTNAMES } from "../constants";
import type { ProjectBundle } from "./projects";
import { requireProjectService } from "./services";

export interface DnsResources {
  zone: gcp.dns.ManagedZone;
  delegationRecords: digitalocean.DnsRecord[];
  productionAddressRecord: gcp.dns.RecordSet;
  stagingAddressRecord: gcp.dns.RecordSet;
  previewAddressRecord: gcp.dns.RecordSet;
  certificateAuthorityRecord: gcp.dns.RecordSet;
}

export function createDigitalOceanProvider(token?: pulumi.Input<string>) {
  const providerToken =
    token ?? new pulumi.Config().requireSecret("digitalOceanToken");
  return new digitalocean.Provider("digitalocean-windrun", {
    token: providerToken,
  });
}

export function createDnsResources(args: {
  shared: ProjectBundle;
  productionAddress: gcp.compute.GlobalAddress;
  stagingAddress: gcp.compute.GlobalAddress;
  digitalOceanProvider: digitalocean.Provider;
}): DnsResources {
  const dnsApi = requireProjectService(
    args.shared.services,
    "dns.googleapis.com",
  );
  const zone = new gcp.dns.ManagedZone(
    "app-zone",
    {
      project: args.shared.project.projectId,
      name: "windrun-app",
      dnsName: HOSTNAMES.delegatedZone,
      description: "Delegated public zone for Windrun applications",
      visibility: "public",
      forceDestroy: true,
    },
    { provider: args.shared.provider, dependsOn: [dnsApi] },
  );

  const assignedNameServers = zone.nameServers.apply((nameServers) => {
    if (nameServers.length !== 4) {
      throw new Error(
        `Cloud DNS must assign exactly four name servers, received ${nameServers.length}`,
      );
    }
    return nameServers;
  });

  const delegationRecords = Array.from({ length: 4 }, (_, index) =>
    new digitalocean.DnsRecord(
      `app-ns-${index + 1}`,
      {
        domain: HOSTNAMES.parentZone,
        type: "NS",
        name: "app",
        ttl: 1800,
        value: assignedNameServers.apply((nameServers) => nameServers[index]),
      },
      { provider: args.digitalOceanProvider, dependsOn: [zone] },
    ),
  );

  function addressRecord(
    logicalName: string,
    name: string,
    address: pulumi.Input<string>,
  ) {
    return new gcp.dns.RecordSet(
      logicalName,
      {
        project: args.shared.project.projectId,
        managedZone: zone.name,
        name,
        type: "A",
        ttl: 300,
        rrdatas: [address],
      },
      { provider: args.shared.provider, dependsOn: [dnsApi, zone] },
    );
  }

  const productionAddressRecord = addressRecord(
    "production-a-record",
    `${HOSTNAMES.production}.`,
    args.productionAddress.address,
  );
  const stagingAddressRecord = addressRecord(
    "staging-a-record",
    `${HOSTNAMES.staging}.`,
    args.stagingAddress.address,
  );
  const previewAddressRecord = addressRecord(
    "preview-a-record",
    `*.${HOSTNAMES.staging}.`,
    args.stagingAddress.address,
  );

  const certificateAuthorityRecord = new gcp.dns.RecordSet(
    "certificate-authority-record",
    {
      project: args.shared.project.projectId,
      managedZone: zone.name,
      name: HOSTNAMES.delegatedZone,
      type: "CAA",
      ttl: 300,
      rrdatas: ['0 issue "pki.goog"', '0 issuewild "pki.goog"'],
    },
    { provider: args.shared.provider, dependsOn: [dnsApi, zone] },
  );

  return {
    zone,
    delegationRecords,
    productionAddressRecord,
    stagingAddressRecord,
    previewAddressRecord,
    certificateAuthorityRecord,
  };
}
