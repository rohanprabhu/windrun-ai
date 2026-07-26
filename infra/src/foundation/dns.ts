import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import { HOSTNAMES } from "../constants";
import type { ProjectBundle } from "./projects";
import { requireProjectService } from "./services";

export interface DnsResources {
  apexZone: gcp.dns.ManagedZone;
  apexNameServers: pulumi.Output<string[]>;
  productionAddressRecord: gcp.dns.RecordSet;
  stagingAddressRecord: gcp.dns.RecordSet;
  previewAddressRecord: gcp.dns.RecordSet;
  certificateAuthorityRecord: gcp.dns.RecordSet;
  businessRecords: gcp.dns.RecordSet[];
}

const preservedBusinessRecords = [
  {
    logicalName: "business-mx-record",
    name: HOSTNAMES.apexZone,
    type: "MX",
    ttl: 300,
    rrdatas: ["1 smtp.google.com."],
  },
  {
    logicalName: "business-google-site-verification-record",
    name: HOSTNAMES.apexZone,
    type: "TXT",
    ttl: 300,
    rrdatas: [
      '"google-site-verification=RNjfWKrI2EKntfBF5bUNllfn_wLNKSYAvSN_UCuYOng"',
    ],
  },
] as const;

export function createDnsResources(args: {
  shared: ProjectBundle;
  productionAddress: gcp.compute.GlobalAddress;
  stagingAddress: gcp.compute.GlobalAddress;
}): DnsResources {
  const dnsApi = requireProjectService(
    args.shared.services,
    "dns.googleapis.com",
  );
  const apexZone = new gcp.dns.ManagedZone(
    "apex-zone",
    {
      project: args.shared.project.projectId,
      name: "windrun-apex",
      dnsName: HOSTNAMES.apexZone,
      description: "Authoritative public zone for Windrun",
      visibility: "public",
      forceDestroy: true,
    },
    { provider: args.shared.provider, dependsOn: [dnsApi] },
  );

  function recordSet(
    logicalName: string,
    name: string,
    type: string,
    ttl: number,
    rrdatas: pulumi.Input<pulumi.Input<string>[]>,
  ) {
    return new gcp.dns.RecordSet(
      logicalName,
      {
        project: args.shared.project.projectId,
        managedZone: apexZone.name,
        name,
        type,
        ttl,
        rrdatas,
      },
      { provider: args.shared.provider, dependsOn: [dnsApi, apexZone] },
    );
  }

  const productionAddressRecord = recordSet(
    "production-a-record",
    `${HOSTNAMES.production}.`,
    "A",
    300,
    [args.productionAddress.address],
  );
  const stagingAddressRecord = recordSet(
    "staging-a-record",
    `${HOSTNAMES.staging}.`,
    "A",
    300,
    [args.stagingAddress.address],
  );
  const previewAddressRecord = recordSet(
    "preview-a-record",
    `*.${HOSTNAMES.staging}.`,
    "A",
    300,
    [args.stagingAddress.address],
  );
  const certificateAuthorityRecord = recordSet(
    "certificate-authority-record",
    HOSTNAMES.apexZone,
    "CAA",
    300,
    ['0 issue "pki.goog"', '0 issuewild "pki.goog"'],
  );
  const businessRecords = preservedBusinessRecords.map((record) =>
    recordSet(
      record.logicalName,
      record.name,
      record.type,
      record.ttl,
      [...record.rrdatas],
    ),
  );

  return {
    apexZone,
    apexNameServers: apexZone.nameServers,
    productionAddressRecord,
    stagingAddressRecord,
    previewAddressRecord,
    certificateAuthorityRecord,
    businessRecords,
  };
}
