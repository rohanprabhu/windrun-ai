import * as digitalocean from "@pulumi/digitalocean";
import * as gcp from "@pulumi/gcp";

import { HOSTNAMES } from "../constants";
import {
  createDnsResources,
  type DnsResources,
} from "./dns";
import type { ProjectBundle } from "./projects";
import { requireProjectService } from "./services";

export interface CaaRecord {
  type: string;
  value: string;
  tag?: string;
}

function caIssuer(value: string) {
  return value
    .split(";", 1)[0]
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

export function validateInheritedCaa(records: ReadonlyArray<CaaRecord>): void {
  const caaRecords = records.filter(
    (record) => record.type.toUpperCase() === "CAA",
  );
  const issue = caaRecords.filter(
    (record) => record.tag?.toLowerCase() === "issue",
  );
  const issueWild = caaRecords.filter(
    (record) => record.tag?.toLowerCase() === "issuewild",
  );

  const authorizesGoogle = (policy: ReadonlyArray<CaaRecord>) =>
    policy.length === 0 ||
    policy.some((record) => caIssuer(record.value) === "pki.goog");
  const wildcardPolicy = issueWild.length > 0 ? issueWild : issue;

  if (!authorizesGoogle(issue) || !authorizesGoogle(wildcardPolicy)) {
    throw new Error(
      "Inherited CAA policy for windrun.ai must authorize pki.goog for issue and issuewild",
    );
  }
}

export interface CertificateResources {
  productionAuthorization: gcp.certificatemanager.DnsAuthorization;
  stagingAuthorization: gcp.certificatemanager.DnsAuthorization;
  productionValidationRecord: gcp.dns.RecordSet;
  stagingValidationRecord: gcp.dns.RecordSet;
  productionCertificate: gcp.certificatemanager.Certificate;
  stagingCertificate: gcp.certificatemanager.Certificate;
  productionCertificateMap: gcp.certificatemanager.CertificateMap;
  stagingCertificateMap: gcp.certificatemanager.CertificateMap;
  productionMapEntry: gcp.certificatemanager.CertificateMapEntry;
  stagingMapEntries: gcp.certificatemanager.CertificateMapEntry[];
}

export interface DnsCertificateResources
  extends DnsResources,
    CertificateResources {}

function createAuthorization(
  logicalName: "production" | "staging",
  domain: string,
  bundle: ProjectBundle,
) {
  return new gcp.certificatemanager.DnsAuthorization(
    `${logicalName}-dns-authorization`,
    {
      project: bundle.project.projectId,
      name: `windrun-${logicalName}`,
      domain,
      location: "global",
      type: "PER_PROJECT_RECORD",
      description: `Windrun ${logicalName} certificate authorization`,
    },
    {
      provider: bundle.provider,
      dependsOn: [
        requireProjectService(
          bundle.services,
          "certificatemanager.googleapis.com",
        ),
      ],
    },
  );
}

function createValidationRecord(args: {
  logicalName: "production" | "staging";
  authorization: gcp.certificatemanager.DnsAuthorization;
  shared: ProjectBundle;
  dns: DnsResources;
}) {
  const authorizationRecord = args.authorization.dnsResourceRecords.apply(
    (records) => {
      if (records.length !== 1) {
        throw new Error(
          `${args.logicalName} DNS authorization must return exactly one record`,
        );
      }
      return records[0];
    },
  );

  return new gcp.dns.RecordSet(
    `${args.logicalName}-validation-record`,
    {
      project: args.shared.project.projectId,
      managedZone: args.dns.zone.name,
      name: authorizationRecord.name,
      type: authorizationRecord.type,
      ttl: 30,
      rrdatas: [authorizationRecord.data],
    },
    {
      provider: args.shared.provider,
      dependsOn: [
        args.authorization,
        requireProjectService(args.shared.services, "dns.googleapis.com"),
      ],
    },
  );
}

function createManagedCertificate(args: {
  logicalName: "production" | "staging";
  domains: string[];
  bundle: ProjectBundle;
  authorization: gcp.certificatemanager.DnsAuthorization;
  validationRecord: gcp.dns.RecordSet;
  dns: DnsResources;
  caaValidated: import("@pulumi/pulumi").Output<boolean>;
}) {
  return new gcp.certificatemanager.Certificate(
    `${args.logicalName}-certificate`,
    {
      project: args.bundle.project.projectId,
      name: `windrun-${args.logicalName}`,
      location: "global",
      scope: "DEFAULT",
      description: `Windrun ${args.logicalName} managed certificate`,
      managed: {
        domains: args.caaValidated.apply(() => args.domains),
        dnsAuthorizations: [args.authorization.id],
      },
    },
    {
      provider: args.bundle.provider,
      dependsOn: [
        args.validationRecord,
        args.dns.certificateAuthorityRecord,
        ...args.dns.delegationRecords,
      ],
    },
  );
}

function createCertificateMap(
  logicalName: "production" | "staging",
  bundle: ProjectBundle,
) {
  return new gcp.certificatemanager.CertificateMap(
    `${logicalName}-certificate-map`,
    {
      project: bundle.project.projectId,
      name: `windrun-${logicalName}`,
      description: `Windrun ${logicalName} certificate map`,
    },
    {
      provider: bundle.provider,
      dependsOn: [
        requireProjectService(
          bundle.services,
          "certificatemanager.googleapis.com",
        ),
      ],
    },
  );
}

function createMapEntry(args: {
  logicalName: string;
  hostname: string;
  bundle: ProjectBundle;
  map: gcp.certificatemanager.CertificateMap;
  certificate: gcp.certificatemanager.Certificate;
}) {
  return new gcp.certificatemanager.CertificateMapEntry(
    args.logicalName,
    {
      project: args.bundle.project.projectId,
      name: args.logicalName,
      map: args.map.name,
      hostname: args.hostname,
      certificates: [args.certificate.id],
      description: `Windrun certificate for ${args.hostname}`,
    },
    {
      provider: args.bundle.provider,
      dependsOn: [args.map, args.certificate],
    },
  );
}

export function createDnsCertificateResources(args: {
  shared: ProjectBundle;
  staging: ProjectBundle;
  production: ProjectBundle;
  productionAddress: gcp.compute.GlobalAddress;
  stagingAddress: gcp.compute.GlobalAddress;
  digitalOceanProvider: digitalocean.Provider;
}): DnsCertificateResources {
  const dns = createDnsResources({
    shared: args.shared,
    productionAddress: args.productionAddress,
    stagingAddress: args.stagingAddress,
    digitalOceanProvider: args.digitalOceanProvider,
  });

  const inheritedCaa = digitalocean.getRecordsOutput(
    {
      domain: HOSTNAMES.parentZone,
      filters: [
        { key: "type", values: ["CAA"] },
        { key: "name", values: ["@"] },
      ],
    },
    { provider: args.digitalOceanProvider },
  );
  const caaValidated = inheritedCaa.records.apply((records) => {
    validateInheritedCaa(records);
    return true;
  });

  const productionAuthorization = createAuthorization(
    "production",
    HOSTNAMES.production,
    args.production,
  );
  const stagingAuthorization = createAuthorization(
    "staging",
    HOSTNAMES.staging,
    args.staging,
  );
  const productionValidationRecord = createValidationRecord({
    logicalName: "production",
    authorization: productionAuthorization,
    shared: args.shared,
    dns,
  });
  const stagingValidationRecord = createValidationRecord({
    logicalName: "staging",
    authorization: stagingAuthorization,
    shared: args.shared,
    dns,
  });
  const productionCertificate = createManagedCertificate({
    logicalName: "production",
    domains: [HOSTNAMES.production],
    bundle: args.production,
    authorization: productionAuthorization,
    validationRecord: productionValidationRecord,
    dns,
    caaValidated,
  });
  const stagingCertificate = createManagedCertificate({
    logicalName: "staging",
    domains: [HOSTNAMES.staging, `*.${HOSTNAMES.staging}`],
    bundle: args.staging,
    authorization: stagingAuthorization,
    validationRecord: stagingValidationRecord,
    dns,
    caaValidated,
  });
  const productionCertificateMap = createCertificateMap(
    "production",
    args.production,
  );
  const stagingCertificateMap = createCertificateMap("staging", args.staging);
  const productionMapEntry = createMapEntry({
    logicalName: "production-certificate-entry",
    hostname: HOSTNAMES.production,
    bundle: args.production,
    map: productionCertificateMap,
    certificate: productionCertificate,
  });
  const stagingMapEntries = [
    createMapEntry({
      logicalName: "staging-certificate-entry",
      hostname: HOSTNAMES.staging,
      bundle: args.staging,
      map: stagingCertificateMap,
      certificate: stagingCertificate,
    }),
    createMapEntry({
      logicalName: "staging-wildcard-certificate-entry",
      hostname: `*.${HOSTNAMES.staging}`,
      bundle: args.staging,
      map: stagingCertificateMap,
      certificate: stagingCertificate,
    }),
  ];

  return {
    ...dns,
    productionAuthorization,
    stagingAuthorization,
    productionValidationRecord,
    stagingValidationRecord,
    productionCertificate,
    stagingCertificate,
    productionCertificateMap,
    stagingCertificateMap,
    productionMapEntry,
    stagingMapEntries,
  };
}
