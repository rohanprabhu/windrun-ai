import { beforeEach, describe, expect, it } from "vitest";

import { HOSTNAMES, PROJECT_IDS } from "../src/constants";
import { createDnsCertificateResources, validateInheritedCaa } from "../src/foundation/certificates";
import { createFoundationCoreResources } from "../src/foundation/core";
import { createProjectBundle, type ProjectBundle } from "../src/foundation/projects";
import { SHARED_APIS, WORKLOAD_APIS } from "../src/foundation/services";
import { createBootstrapProvider } from "../src/providers";
import {
  MOCK_PRODUCTION_IP,
  MOCK_STAGING_IP,
  gcpResourcesWithoutExplicitProvider,
  mockUrn,
  resolveOutput,
  resourcesOfType,
  setWindrunMocks,
} from "./helpers/pulumi-mocks";

async function settleBundles(bundles: ProjectBundle[]) {
  await Promise.all(
    bundles.flatMap((bundle) => [
      resolveOutput(bundle.project.urn),
      resolveOutput(bundle.provider.urn),
      ...Object.values(bundle.services).map((service) =>
        resolveOutput(service.urn),
      ),
    ]),
  );
}

async function createFixture() {
  const bootstrapProvider = createBootstrapProvider();
  const shared = createProjectBundle({
    logicalName: "shared",
    projectId: PROJECT_IDS.shared,
    bootstrapProvider,
    allowProjectDeletion: false,
    services: SHARED_APIS,
  });
  const staging = createProjectBundle({
    logicalName: "staging",
    projectId: PROJECT_IDS.staging,
    bootstrapProvider,
    allowProjectDeletion: false,
    services: WORKLOAD_APIS,
  });
  const production = createProjectBundle({
    logicalName: "production",
    projectId: PROJECT_IDS.production,
    bootstrapProvider,
    allowProjectDeletion: false,
    services: WORKLOAD_APIS,
  });
  await settleBundles([shared, staging, production]);

  const core = createFoundationCoreResources({ staging, production });
  const dnsCertificates = createDnsCertificateResources({
    shared,
    staging,
    production,
    productionAddress: core.productionAddress,
    stagingAddress: core.stagingAddress,
    allowStagingCertificateReplacement: false,
  });

  await Promise.all([
    resolveOutput(dnsCertificates.apexZone.urn),
    resolveOutput(dnsCertificates.apexNameServers),
    resolveOutput(dnsCertificates.productionAddressRecord.urn),
    resolveOutput(dnsCertificates.stagingAddressRecord.urn),
    resolveOutput(dnsCertificates.previewAddressRecord.urn),
    resolveOutput(dnsCertificates.certificateAuthorityRecord.urn),
    ...dnsCertificates.businessRecords.map((record) =>
      resolveOutput(record.urn),
    ),
    resolveOutput(dnsCertificates.productionAuthorization.urn),
    resolveOutput(dnsCertificates.stagingAuthorization.urn),
    resolveOutput(dnsCertificates.productionValidationRecord.urn),
    resolveOutput(dnsCertificates.stagingValidationRecord.urn),
    resolveOutput(dnsCertificates.productionCertificate.urn),
    resolveOutput(dnsCertificates.stagingCertificate.urn),
    resolveOutput(dnsCertificates.productionCertificateMap.urn),
    resolveOutput(dnsCertificates.stagingCertificateMap.urn),
    resolveOutput(dnsCertificates.productionMapEntry.urn),
    ...dnsCertificates.stagingMapEntries.map((entry) =>
      resolveOutput(entry.urn),
    ),
  ]);

  return dnsCertificates;
}

beforeEach(async () => {
  await setWindrunMocks("foundation-dns-test");
});

describe("shared DNS and certificate lifecycle", () => {
  it("creates one authoritative apex zone and routes application hosts", async () => {
    await createFixture();

    const zones = resourcesOfType("gcp:dns/managedZone:ManagedZone");
    expect(zones).toHaveLength(1);
    expect(zones[0].inputs).toMatchObject({
      project: PROJECT_IDS.shared,
      name: "windrun-apex",
      dnsName: "windrun.ai.",
      visibility: "public",
      forceDestroy: true,
    });
    expect(resourcesOfType("digitalocean:index/dnsRecord:DnsRecord")).toEqual([]);

    const recordSets = resourcesOfType("gcp:dns/recordSet:RecordSet");
    for (const record of recordSets) {
      expect(record.inputs.managedZone).toBe("windrun-apex");
    }
    expect(recordSets.find((resource) => resource.name === "production-a-record")?.inputs).toMatchObject({
      name: "app.windrun.ai.",
      type: "A",
      rrdatas: [MOCK_PRODUCTION_IP],
    });
    expect(recordSets.find((resource) => resource.name === "staging-a-record")?.inputs).toMatchObject({
      name: "app.staging.windrun.ai.",
      type: "A",
      rrdatas: [MOCK_STAGING_IP],
    });
    expect(recordSets.find((resource) => resource.name === "preview-a-record")?.inputs).toMatchObject({
      name: "*.app.staging.windrun.ai.",
      type: "A",
      rrdatas: [MOCK_STAGING_IP],
    });
    expect(recordSets.find((resource) => resource.name === "certificate-authority-record")?.inputs).toMatchObject({
      name: "windrun.ai.",
      type: "CAA",
      rrdatas: ['0 issue "pki.goog"', '0 issuewild "pki.goog"'],
    });
    expect(recordSets.find((resource) => resource.name === "business-mx-record")?.inputs).toMatchObject({
      name: "windrun.ai.",
      type: "MX",
      ttl: 300,
      rrdatas: ["1 smtp.google.com."],
    });
    expect(recordSets.find((resource) => resource.name === "business-google-site-verification-record")?.inputs).toMatchObject({
      name: "windrun.ai.",
      type: "TXT",
      ttl: 300,
      rrdatas: [
        '"google-site-verification=RNjfWKrI2EKntfBF5bUNllfn_wLNKSYAvSN_UCuYOng"',
      ],
    });
  });

  it("copies authorization records verbatim and enforces certificate ordering", async () => {
    await createFixture();

    const authorizations = resourcesOfType(
      "gcp:certificatemanager/dnsAuthorization:DnsAuthorization",
    );
    expect(authorizations).toHaveLength(2);
    expect(
      authorizations.find(
        (resource) => resource.name === "production-dns-authorization",
      )?.inputs,
    ).toMatchObject({
      project: PROJECT_IDS.production,
      domain: HOSTNAMES.production,
      location: "global",
      type: "PER_PROJECT_RECORD",
    });
    expect(
      authorizations.find(
        (resource) => resource.name === "staging-app-dns-authorization",
      )?.inputs,
    ).toMatchObject({
      project: PROJECT_IDS.staging,
      domain: HOSTNAMES.staging,
      location: "global",
      type: "PER_PROJECT_RECORD",
    });

    const recordSets = resourcesOfType("gcp:dns/recordSet:RecordSet");
    const productionValidation = recordSets.find(
      (resource) => resource.name === "production-validation-record",
    );
    expect(productionValidation?.inputs).toMatchObject({
      name: "_acme-challenge.production-dns-authorization.app.windrun.ai.",
      type: "CNAME",
      rrdatas: [
        "production-dns-authorization.authorize.certificatemanager.goog.",
      ],
    });
    const stagingValidation = recordSets.find(
      (resource) => resource.name === "staging-app-validation-record",
    );
    expect(stagingValidation?.inputs).toMatchObject({
      name: "_acme-challenge.staging-app-dns-authorization.app.staging.windrun.ai.",
      type: "CNAME",
      rrdatas: [
        "staging-app-dns-authorization.authorize.certificatemanager.goog.",
      ],
    });

    const certificates = resourcesOfType(
      "gcp:certificatemanager/certificate:Certificate",
    );
    const productionCertificate = certificates.find(
      (resource) => resource.name === "production-certificate",
    );
    expect(productionCertificate?.inputs.managed).toMatchObject({
      domains: [HOSTNAMES.production],
      dnsAuthorizations: ["production-dns-authorization-id"],
    });
    const stagingCertificate = certificates.find(
      (resource) => resource.name === "staging-app-certificate",
    );
    expect(stagingCertificate?.inputs.managed).toMatchObject({
      domains: [HOSTNAMES.staging, `*.${HOSTNAMES.staging}`],
      dnsAuthorizations: ["staging-app-dns-authorization-id"],
    });

    for (const [logicalName, certificate] of [
      ["production", productionCertificate],
      ["staging", stagingCertificate],
    ] as const) {
      expect(certificate?.provider).toContain(
        mockUrn(
          "pulumi:providers:gcp",
          `gcp-${logicalName}`,
          "foundation-dns-test",
        ),
      );
      expect(certificate?.dependencies).toContain(
        mockUrn(
          "gcp:dns/recordSet:RecordSet",
          logicalName === "production"
            ? "production-validation-record"
            : "staging-app-validation-record",
          "foundation-dns-test",
        ),
      );
      expect(certificate?.dependencies).toContain(
        mockUrn(
          "gcp:dns/recordSet:RecordSet",
          "certificate-authority-record",
          "foundation-dns-test",
        ),
      );
    }

    expect(productionValidation?.dependencies).toContain(
      mockUrn(
        "gcp:certificatemanager/dnsAuthorization:DnsAuthorization",
        "production-dns-authorization",
        "foundation-dns-test",
      ),
    );
    expect(stagingValidation?.dependencies).toContain(
      mockUrn(
        "gcp:certificatemanager/dnsAuthorization:DnsAuthorization",
        "staging-app-dns-authorization",
        "foundation-dns-test",
      ),
    );

    const entries = resourcesOfType(
      "gcp:certificatemanager/certificateMapEntry:CertificateMapEntry",
    );
    expect(entries).toHaveLength(3);
    expect(entries.map((resource) => resource.inputs.hostname).sort()).toEqual([
      "*.app.staging.windrun.ai",
      "app.staging.windrun.ai",
      "app.windrun.ai",
    ]);
    for (const entry of entries) {
      const logicalName = entry.name.startsWith("production")
        ? "production"
        : "staging";
      expect(entry.dependencies).toContain(
        mockUrn(
          "gcp:certificatemanager/certificate:Certificate",
          logicalName === "production"
            ? "production-certificate"
            : "staging-app-certificate",
          "foundation-dns-test",
        ),
      );
    }

    expect(resourcesOfType("gcp:certificatemanager/certificateMap:CertificateMap")).toHaveLength(2);
    expect(gcpResourcesWithoutExplicitProvider()).toEqual([]);
  });
});

describe("validateInheritedCaa", () => {
  it("allows an absent policy and Google-authorized issuance", () => {
    expect(() => validateInheritedCaa([])).not.toThrow();
    expect(() =>
      validateInheritedCaa([
        { type: "CAA", tag: "issue", value: "pki.goog" },
      ]),
    ).not.toThrow();
    expect(() =>
      validateInheritedCaa([
        { type: "CAA", tag: "iodef", value: "mailto:security@windrun.ai" },
      ]),
    ).not.toThrow();
  });

  it("rejects inherited issue or issuewild policies that exclude pki.goog", () => {
    expect(() =>
      validateInheritedCaa([
        { type: "CAA", tag: "issue", value: "letsencrypt.org" },
      ]),
    ).toThrow("must authorize pki.goog");
    expect(() =>
      validateInheritedCaa([
        { type: "CAA", tag: "issue", value: "pki.goog" },
        { type: "CAA", tag: "issuewild", value: "letsencrypt.org" },
      ]),
    ).toThrow("must authorize pki.goog");
  });
});
