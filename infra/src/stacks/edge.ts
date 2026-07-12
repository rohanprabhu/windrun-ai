import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import { HOSTNAMES, REGION, SERVICE_NAMES } from "../constants";

export interface EdgeStackArgs {
  kind: "production-edge" | "staging-edge";
  projectId: pulumi.Input<string>;
  provider: gcp.Provider;
  globalAddress: pulumi.Input<string>;
  certificateMapId: pulumi.Input<string>;
}

export interface EdgeStackOutputs {
  publicUrl: pulumi.Output<string>;
}

type EdgeName = "production" | "staging";

function createNeg(args: {
  logicalName: string;
  physicalName: string;
  projectId: pulumi.Input<string>;
  provider: gcp.Provider;
  cloudRun: gcp.types.input.compute.RegionNetworkEndpointGroupCloudRun;
}) {
  return new gcp.compute.RegionNetworkEndpointGroup(
    args.logicalName,
    {
      project: args.projectId,
      name: args.physicalName,
      region: REGION,
      networkEndpointType: "SERVERLESS",
      cloudRun: args.cloudRun,
    },
    { provider: args.provider },
  );
}

function createBackend(args: {
  logicalName: string;
  physicalName: string;
  projectId: pulumi.Input<string>;
  provider: gcp.Provider;
  neg: gcp.compute.RegionNetworkEndpointGroup;
}) {
  return new gcp.compute.BackendService(
    args.logicalName,
    {
      project: args.projectId,
      name: args.physicalName,
      protocol: "HTTP",
      loadBalancingScheme: "EXTERNAL_MANAGED",
      backends: [{ group: args.neg.id }],
    },
    { provider: args.provider, dependsOn: [args.neg] },
  );
}

function createFrontends(args: {
  logicalName: EdgeName;
  projectId: pulumi.Input<string>;
  provider: gcp.Provider;
  globalAddress: pulumi.Input<string>;
  certificateMapId: pulumi.Input<string>;
  httpsUrlMap: gcp.compute.URLMap;
  publicHost: string;
}): EdgeStackOutputs {
  const redirectUrlMap = new gcp.compute.URLMap(
    `${args.logicalName}-http-redirect-url-map`,
    {
      project: args.projectId,
      name: `windrun-${args.logicalName}-http-redirect`,
      defaultUrlRedirect: {
        httpsRedirect: true,
        stripQuery: false,
      },
    },
    { provider: args.provider },
  );
  const httpsProxy = new gcp.compute.TargetHttpsProxy(
    `${args.logicalName}-https-proxy`,
    {
      project: args.projectId,
      name: `windrun-${args.logicalName}-https`,
      urlMap: args.httpsUrlMap.id,
      certificateMap: pulumi.interpolate`//certificatemanager.googleapis.com/${args.certificateMapId}`,
    },
    { provider: args.provider, dependsOn: [args.httpsUrlMap] },
  );
  const httpProxy = new gcp.compute.TargetHttpProxy(
    `${args.logicalName}-http-proxy`,
    {
      project: args.projectId,
      name: `windrun-${args.logicalName}-http`,
      urlMap: redirectUrlMap.id,
    },
    { provider: args.provider, dependsOn: [redirectUrlMap] },
  );
  const httpsForwardingRule = new gcp.compute.GlobalForwardingRule(
    `${args.logicalName}-https-forwarding-rule`,
    {
      project: args.projectId,
      name: `windrun-${args.logicalName}-https`,
      ipAddress: args.globalAddress,
      ipProtocol: "TCP",
      portRange: "443",
      loadBalancingScheme: "EXTERNAL_MANAGED",
      networkTier: "PREMIUM",
      target: httpsProxy.id,
    },
    { provider: args.provider, dependsOn: [httpsProxy] },
  );
  const httpForwardingRule = new gcp.compute.GlobalForwardingRule(
    `${args.logicalName}-http-forwarding-rule`,
    {
      project: args.projectId,
      name: `windrun-${args.logicalName}-http`,
      ipAddress: args.globalAddress,
      ipProtocol: "TCP",
      portRange: "80",
      loadBalancingScheme: "EXTERNAL_MANAGED",
      networkTier: "PREMIUM",
      target: httpProxy.id,
    },
    { provider: args.provider, dependsOn: [httpProxy] },
  );

  return {
    publicUrl: pulumi
      .all([httpsForwardingRule.id, httpForwardingRule.id])
      .apply(() => `https://${args.publicHost}`),
  };
}

function createProductionEdge(args: EdgeStackArgs): EdgeStackOutputs {
  const primaryNeg = createNeg({
    logicalName: "production-primary-neg",
    physicalName: "windrun-production-primary",
    projectId: args.projectId,
    provider: args.provider,
    cloudRun: { service: SERVICE_NAMES.production },
  });
  const primaryBackend = createBackend({
    logicalName: "production-primary-backend",
    physicalName: "windrun-production-primary",
    projectId: args.projectId,
    provider: args.provider,
    neg: primaryNeg,
  });
  const httpsUrlMap = new gcp.compute.URLMap(
    "production-https-url-map",
    {
      project: args.projectId,
      name: "windrun-production-https",
      defaultService: primaryBackend.id,
    },
    { provider: args.provider, dependsOn: [primaryBackend] },
  );

  return createFrontends({
    logicalName: "production",
    projectId: args.projectId,
    provider: args.provider,
    globalAddress: args.globalAddress,
    certificateMapId: args.certificateMapId,
    httpsUrlMap,
    publicHost: HOSTNAMES.production,
  });
}

function createStagingEdge(args: EdgeStackArgs): EdgeStackOutputs {
  const primaryNeg = createNeg({
    logicalName: "staging-primary-neg",
    physicalName: "windrun-staging-primary",
    projectId: args.projectId,
    provider: args.provider,
    cloudRun: { service: SERVICE_NAMES.staging },
  });
  const previewNeg = createNeg({
    logicalName: "staging-preview-neg",
    physicalName: "windrun-staging-preview",
    projectId: args.projectId,
    provider: args.provider,
    cloudRun: { urlMask: `<service>.${HOSTNAMES.previewSuffix}` },
  });
  const primaryBackend = createBackend({
    logicalName: "staging-primary-backend",
    physicalName: "windrun-staging-primary",
    projectId: args.projectId,
    provider: args.provider,
    neg: primaryNeg,
  });
  const previewBackend = createBackend({
    logicalName: "staging-preview-backend",
    physicalName: "windrun-staging-preview",
    projectId: args.projectId,
    provider: args.provider,
    neg: previewNeg,
  });
  const httpsUrlMap = new gcp.compute.URLMap(
    "staging-https-url-map",
    {
      project: args.projectId,
      name: "windrun-staging-https",
      defaultService: primaryBackend.id,
      hostRules: [
        {
          hosts: [HOSTNAMES.staging],
          pathMatcher: "staging-primary",
        },
        {
          hosts: [`*.${HOSTNAMES.staging}`],
          pathMatcher: "staging-previews",
        },
      ],
      pathMatchers: [
        {
          name: "staging-primary",
          defaultService: primaryBackend.id,
        },
        {
          name: "staging-previews",
          defaultService: previewBackend.id,
        },
      ],
    },
    {
      provider: args.provider,
      dependsOn: [primaryBackend, previewBackend],
    },
  );

  return createFrontends({
    logicalName: "staging",
    projectId: args.projectId,
    provider: args.provider,
    globalAddress: args.globalAddress,
    certificateMapId: args.certificateMapId,
    httpsUrlMap,
    publicHost: HOSTNAMES.staging,
  });
}

export function createEdgeStack(args: EdgeStackArgs): EdgeStackOutputs {
  return args.kind === "production-edge"
    ? createProductionEdge(args)
    : createStagingEdge(args);
}
