# Cloud DNS Authoritative Zone Migration

## Decision

Move Windrun DNS hosting from DigitalOcean to Google Cloud DNS, while leaving the domain registrar as a manual administrative boundary. Pulumi will manage the authoritative `windrun.ai.` public Cloud DNS zone and all records required by the platform. No registrar API token belongs in Pulumi.

## Goals

- Remove the DigitalOcean provider and `windrun-ai:digitalOceanToken` from the infrastructure project.
- Keep all routine DNS changes in Pulumi and Google Cloud.
- Avoid introducing a new registrar API token, service-account key, or another cloud provider.
- Preserve existing non-application DNS records, especially Google Workspace mail and domain verification records.
- Make the migration safe to preview, review, apply, and roll forward.

## Non-goals

- Do not transfer domain registration.
- Do not automate registrar nameserver changes.
- Do not manage Google Workspace itself.
- Do not delete existing DigitalOcean DNS until Cloud DNS is fully populated and delegated.

## Architecture

The foundation stack creates one shared-project Cloud DNS public managed zone for `windrun.ai.`. Application, staging, preview, certificate validation, CAA, and imported business records live in that zone as `gcp.dns.RecordSet` resources.

The current `app.windrun.ai.` and `staging.windrun.ai.` delegated zones are replaced by records in the apex zone:

- `app.windrun.ai. A` -> production load balancer IP
- `app.staging.windrun.ai. A` -> staging load balancer IP
- `*.app.staging.windrun.ai. A` -> staging load balancer IP
- certificate validation CNAMEs -> generated Certificate Manager validation targets
- `windrun.ai. CAA` -> Google Trust Services issuance records
- imported MX/TXT/CNAME records required for email and domain ownership

After Pulumi creates the apex zone and all records, the registrar nameservers for `windrun.ai` are manually changed to the four Google Cloud DNS nameservers assigned to that zone.

## Data flow

```text
Registrar for windrun.ai
  -> NS records point to Google Cloud DNS
  -> Cloud DNS windrun.ai. zone
  -> Pulumi-managed records
  -> Google load balancers / Google Workspace / verification services
```

Pulumi no longer calls DigitalOcean. The only registrar interaction is the one-time human nameserver update.

## Migration sequence

1. Export the current DigitalOcean `windrun.ai` DNS record set.
2. Classify records into:
   - platform records Pulumi already knows how to derive,
   - business records Pulumi should preserve as static config/code,
   - obsolete delegated records to remove after cutover.
3. Update foundation Pulumi code to create the `windrun.ai.` Cloud DNS zone and record sets.
4. Remove DigitalOcean provider construction, delegation records, token config, tests, and docs.
5. Preview foundation and inspect the new Cloud DNS zone record set.
6. Apply foundation.
7. Manually change registrar nameservers to the Cloud DNS zone nameservers.
8. Verify DNS resolution for app, staging, preview wildcard, mail, SPF/DKIM/DMARC, and certificate validation records.
9. After propagation, optionally remove the old DigitalOcean zone from the registrar account.

## Safety rules

- The migration must not depend on DigitalOcean API access.
- The registrar change is manual and must happen only after the Cloud DNS zone contains all required records.
- The foundation stack must output the assigned Cloud DNS nameservers so the operator can copy them into the registrar.
- The implementation must include tests proving no DigitalOcean provider/resource/config remains.
- Mail records must be explicitly represented before cutover; absence of MX/TXT verification records is a blocker.

## Testing

- Unit tests assert only `gcp.dns.ManagedZone` and `gcp.dns.RecordSet` resources are created for DNS.
- Static config tests assert `windrun-ai:digitalOceanToken` is absent.
- Dependency tests assert `@pulumi/digitalocean` is absent.
- Documentation tests assert the manual registrar boundary and verification checklist are recorded.
- Post-apply smoke checks query:
  - `app.windrun.ai`
  - `app.staging.windrun.ai`
  - `pr-1.app.staging.windrun.ai`
  - `windrun.ai MX`
  - SPF/DKIM/DMARC TXT records, once known

