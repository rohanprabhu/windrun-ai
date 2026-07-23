import * as digitalocean from "@pulumi/digitalocean";
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import { HOSTNAMES } from "../constants";
import type { ProjectBundle } from "./projects";
import { requireProjectService } from "./services";

export interface DnsResources {
  productionZone: gcp.dns.ManagedZone;
  stagingZone: gcp.dns.ManagedZone;
  delegationRecords: digitalocean.DnsRecord[];
  productionAddressRecord: gcp.dns.RecordSet;
  stagingAddressRecord: gcp.dns.RecordSet;
  previewAddressRecord: gcp.dns.RecordSet;
  productionCertificateAuthorityRecord: gcp.dns.RecordSet;
  stagingCertificateAuthorityRecord: gcp.dns.RecordSet;
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
  const productionZone = new gcp.dns.ManagedZone(
    "app-zone",
    {
      project: args.shared.project.projectId,
      name: "windrun-app",
      dnsName: HOSTNAMES.productionZone,
      description: "Delegated public zone for Windrun applications",
      visibility: "public",
      forceDestroy: true,
    },
    { provider: args.shared.provider, dependsOn: [dnsApi] },
  );

  const stagingZone = new gcp.dns.ManagedZone(
    "staging-zone",
    {
      project: args.shared.project.projectId,
      name: "windrun-staging",
      dnsName: HOSTNAMES.stagingZone,
      description: "Delegated public zone for Windrun staging applications",
      visibility: "public",
      forceDestroy: true,
    },
    { provider: args.shared.provider, dependsOn: [dnsApi] },
  );

  function createDelegationRecords(
    label: "app" | "staging",
    zone: gcp.dns.ManagedZone,
  ) {
    const assignedNameServers = zone.nameServers.apply((nameServers) => {
      if (nameServers.length !== 4) {
        throw new Error(
          `Cloud DNS ${label} zone must assign exactly four name servers, received ${nameServers.length}`,
        );
      }
      return nameServers;
    });

    return Array.from({ length: 4 }, (_, index) =>
      new digitalocean.DnsRecord(
        `${label}-ns-${index + 1}`,
        {
          domain: HOSTNAMES.parentZone,
          type: "NS",
          name: label,
          ttl: 1800,
          value: assignedNameServers.apply((nameServers) => nameServers[index]),
        },
        { provider: args.digitalOceanProvider, dependsOn: [zone] },
      ),
    );
  }

  const delegationRecords = [
    ...createDelegationRecords("app", productionZone),
    ...createDelegationRecords("staging", stagingZone),
  ];

  function addressRecord(
    logicalName: string,
    zone: gcp.dns.ManagedZone,
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
    productionZone,
    `${HOSTNAMES.production}.`,
    args.productionAddress.address,
  );
  const stagingAddressRecord = addressRecord(
    "staging-a-record",
    stagingZone,
    `${HOSTNAMES.staging}.`,
    args.stagingAddress.address,
  );
  const previewAddressRecord = addressRecord(
    "preview-a-record",
    stagingZone,
    `*.${HOSTNAMES.staging}.`,
    args.stagingAddress.address,
  );

  function certificateAuthorityRecord(
    logicalName: string,
    zone: gcp.dns.ManagedZone,
    zoneName: string,
  ) {
    return new gcp.dns.RecordSet(
      logicalName,
      {
        project: args.shared.project.projectId,
        managedZone: zone.name,
        name: zoneName,
        type: "CAA",
        ttl: 300,
        rrdatas: ['0 issue "pki.goog"', '0 issuewild "pki.goog"'],
      },
      { provider: args.shared.provider, dependsOn: [dnsApi, zone] },
    );
  }

  return {
    productionZone,
    stagingZone,
    delegationRecords,
    productionAddressRecord,
    stagingAddressRecord,
    previewAddressRecord,
    productionCertificateAuthorityRecord: certificateAuthorityRecord(
      "certificate-authority-record",
      productionZone,
      HOSTNAMES.productionZone,
    ),
    stagingCertificateAuthorityRecord: certificateAuthorityRecord(
      "staging-certificate-authority-record",
      stagingZone,
      HOSTNAMES.stagingZone,
    ),
  };
}
