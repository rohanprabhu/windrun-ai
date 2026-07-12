# Windrun Cloud Run Platform Design

## Purpose

Build and operate a polished Next.js “hello world” application on Google Cloud Run with a Vercel-like delivery experience. Production and non-production are strictly isolated in different Google Cloud projects. Production has its own dedicated global HTTPS load balancer. Staging has a different dedicated global HTTPS load balancer that serves the primary staging application and any number of dynamically created preview stacks without changing the load balancer when previews appear or disappear.

Every cloud resource change is performed by Pulumi. Shell scripts and GitHub Actions may select stacks and invoke `pulumi preview`, `pulumi up`, or `pulumi destroy`; they must not create, update, or delete cloud resources through `gcloud`, `doctl`, or vendor consoles.

## Success Criteria

- `https://app.windrun.ai` serves the production Cloud Run service through the production load balancer.
- `https://staging.app.windrun.ai` serves the primary staging Cloud Run service through the staging load balancer.
- `https://pr-<number>.staging.app.windrun.ai` serves the Cloud Run service owned by Pulumi stack `pr-<number>`.
- Opening or updating a pull request creates or updates its preview stack; closing it destroys the preview stack.
- Production, staging/previews, and shared DNS/control resources live in three different Google Cloud projects.
- The staging load balancer routes new preview services through a serverless NEG URL mask and is not updated by preview-stack deployments.
- The production project and production deployment identity have no access to the staging project, and staging/preview deployment identities have no access to the production project.
- The DigitalOcean parent-zone delegation, Cloud DNS records, certificates, load balancers, Cloud Run services, registries, IAM, and CI federation are Pulumi-managed.
- Environment and full-platform teardown are documented, ordered, and reproducible.

## Fixed Decisions

| Concern | Decision |
| --- | --- |
| Runtime | Next.js App Router on Node.js 22 LTS, packaged with standalone output |
| Package manager | pnpm, pinned through `packageManager` and Corepack |
| Application region | `asia-south1` (Mumbai) |
| Infrastructure language | Pulumi TypeScript |
| State backend | Clean Pulumi Cloud individual account created for Windrun and claimed by `rohan@windrun.ai` after the initial work |
| Production domain | `app.windrun.ai` |
| Staging domain | `staging.app.windrun.ai` |
| Preview domain | `<service>.staging.app.windrun.ai`, where pull requests use service name `pr-<number>` |
| Parent DNS | DigitalOcean remains authoritative for `windrun.ai` |
| Delegated DNS | DigitalOcean delegates `app.windrun.ai` to a Cloud DNS public zone |
| TLS | Google Certificate Manager DNS-authorized managed certificates and certificate maps |
| Ingress | Global external managed Application Load Balancers backed by Cloud Run serverless NEGs |
| Direct Cloud Run ingress | Restricted to internal traffic and Cloud Load Balancing |
| CI cloud authentication | GitHub OIDC to Pulumi Cloud and Google Workload Identity Federation; no service-account JSON keys |

## Project Isolation

The foundation stack creates exactly three Google Cloud projects under the `windrun.ai` Google Cloud Organization (`391332700711`) and attaches each to billing account `018EDA-2A53D0-A39B57`:

| Project ID | Responsibility |
| --- | --- |
| `windrun-ai-shared-20260712` | Cloud DNS public zone, stable shared control-plane resources, and foundation identity |
| `windrun-ai-staging-20260712` | Staging and preview Cloud Run services, staging Artifact Registry, staging load balancer, and staging CI identities |
| `windrun-ai-prod-20260712` | Production Cloud Run service, production Artifact Registry, production load balancer, and production CI identity |

There is no Shared VPC and no runtime network connection between production and staging. Each load balancer, backend service, serverless NEG, certificate, image repository, runtime service account, and Cloud Run service lives in the same project as the environment it serves. Explicit `gcp.Provider` instances are required for all resources and default GCP providers are disabled, preventing ambient CLI configuration from placing a resource in the wrong project. Only the foundation stack can write to the shared Cloud DNS zone. Routine application deployment identities cannot alter DNS, certificates, project IAM, billing, or resources in another project.

## Pulumi Stack Ownership

One Pulumi project lives in `infra/`. Stack configuration selects one of the following stack kinds:

| Stack | Owns |
| --- | --- |
| `foundation` | Three GCP projects, required APIs, Artifact Registry repositories, reserved global IP addresses, Cloud DNS zone, DigitalOcean NS delegation, DNS A/wildcard records, Certificate Manager DNS authorizations/certificates/maps, runtime service accounts, GitHub/GCP federation, and Pulumi Cloud GitHub OIDC issuer |
| `production-edge` | Production serverless NEG, backend service, URL map, HTTPS proxy, HTTP-to-HTTPS redirect, and global forwarding rules |
| `production` | Commit-addressed production image, production Cloud Run v2 service, and unauthenticated invoker binding |
| `staging-edge` | Primary staging NEG/backend, preview URL-mask NEG/backend, host routing, HTTPS proxy, redirect, and global forwarding rules |
| `staging` | Commit-addressed primary staging image, staging Cloud Run v2 service, and invoker binding |
| `pr-<number>` | Commit-addressed preview image, one `pr-<number>` Cloud Run v2 service, and its invoker binding |

Stable edge resources are deliberately separate from application stacks. Normal pushes update only an application stack. Preview stacks never import, update, or depend on another preview stack and never own a load-balancer or DNS resource.

The initial deployment order is `foundation`, `production`, `production-edge`, `staging`, then `staging-edge`. The edge stacks refer to the fixed Cloud Run service names `production` and `staging`, so the primary services are created first. Preview stacks can be created after `staging-edge` is active.

## Request Routing

### Production

1. `app.windrun.ai` resolves through the delegated Cloud DNS zone to a global IP reserved in the production project.
2. Port 80 redirects to HTTPS. Port 443 uses the production Certificate Manager map on an `EXTERNAL_MANAGED`, Premium-tier frontend.
3. The production URL map has one backend only.
4. The production backend contains one `asia-south1` serverless NEG pointing explicitly to Cloud Run service `production` in the production project.
5. Cloud Run accepts the request only through Cloud Load Balancing and serves the production revision.

### Staging and previews

1. Both `staging.app.windrun.ai` and `*.staging.app.windrun.ai` resolve to the global IP reserved in the staging project.
2. The staging certificate covers the staging apex and its first-level wildcard on an `EXTERNAL_MANAGED`, Premium-tier frontend.
3. Host `staging.app.windrun.ai` routes to an explicit serverless NEG for Cloud Run service `staging`.
4. Host pattern `*.staging.app.windrun.ai` routes to a second backend whose serverless NEG has URL mask `<service>.staging.app.windrun.ai`.
5. The URL mask extracts the hostname label and routes it to the same-named Cloud Run service in `windrun-ai-staging-20260712` and `asia-south1`.
6. Creating service `pr-42` makes `pr-42.staging.app.windrun.ai` routable without changing DNS, the URL map, the backend service, or the NEG. Destroying that service removes the environment without an edge update.

The preview-mask backend intentionally exposes only same-project Cloud Run services that allow unauthenticated invocation. Any internal Cloud Run service must retain authenticated invocation, in which case the public load balancer cannot expose it successfully even if a matching hostname is requested.

## DNS and Certificates

The foundation stack creates a Cloud DNS public zone for `app.windrun.ai` in the shared project. Its assigned name servers are written as NS records in the existing DigitalOcean `windrun.ai` zone using the dedicated Domain-only DigitalOcean token.

The foundation stack reserves the production and staging global IPv4 addresses in their respective projects, then creates these Cloud DNS records:

- `app.windrun.ai A <production-global-ip>`
- `staging.app.windrun.ai A <staging-global-ip>`
- `*.staging.app.windrun.ai A <staging-global-ip>`

Certificate Manager DNS authorization is created in each environment project with `type: "PER_PROJECT_RECORD"`. The returned CNAME validation records are written verbatim into the shared Cloud DNS zone by the foundation stack and retained for automatic renewal. The production certificate covers `app.windrun.ai`. One staging DNS authorization covers both `staging.app.windrun.ai` and `*.staging.app.windrun.ai`. The foundation preview checks inherited CAA records and requires Google Trust Services (`pki.goog`) to be permitted. Certificate maps remain in their corresponding environment projects and are referenced by the edge stacks.

## Application Experience

The existing Vite starter is replaced by a focused Next.js App Router application. The page is a polished “Windrun launch console” rather than a static heading:

- Animated atmospheric gradient and wind-line background implemented in CSS, with reduced-motion support.
- A prominent “Hello from Cloud Run” hero whose copy changes to Production, Staging, or Preview using deployment metadata.
- A live status panel showing service, environment, region, Cloud Run revision, commit SHA, server time, and request latency.
- A “Ping this deployment” interaction that calls `/api/status`, measures round-trip latency, and displays a short request identifier.
- A small interactive wind-strength control that changes the visual motion locally without persisting data.
- Copyable deployment URL and JSON status link.
- Responsive layout, semantic landmarks, keyboard support, visible focus, light/dark adaptation, and reduced-motion behavior.

`GET /api/health` returns a minimal health response. `GET /api/status` returns a typed, non-sensitive JSON document derived from `APP_ENV`, `GCP_PROJECT_ID`, `GOOGLE_CLOUD_REGION`, `GIT_COMMIT_SHA`, `K_SERVICE`, and `K_REVISION`. Missing metadata uses explicit local-development values rather than failing the page.

## Container and Image Flow

The Next.js build uses `output: "standalone"`. A multi-stage Dockerfile installs with `pnpm install --frozen-lockfile`, runs tests/build outside the runtime stage, and copies only standalone server files, static assets, and public assets into a non-root Node.js 22 image. The container listens on `0.0.0.0` and the Cloud Run `PORT` value.

Pulumi uses the modern Docker Build provider to build and push an image to the environment project’s Artifact Registry. Image tags include the Git commit SHA and stack-safe environment name. Cloud Run receives the pushed repository digest rather than a mutable `latest` reference, ensuring a code change creates a new revision and unchanged code does not drift.

## CI/CD and Branch Mapping

GitHub repository `rohanprabhu/windrun-ai` is the sole trusted source.

| Git event | Action |
| --- | --- |
| Pull request opened, reopened, or synchronized | Test, build, deploy/update stack `pr-<number>` in the staging project, smoke-test its wildcard URL, and comment/update the preview URL |
| Pull request closed | Destroy `pr-<number>`, then remove the empty Pulumi stack |
| Push to `staging` | Test and deploy stack `staging` only |
| Push to `main` | Test and deploy stack `production` only |
| Manual edge workflow | Preview and apply `production-edge` or `staging-edge` after required review |
| Manual foundation workflow | Preview and apply `foundation` after required review |

Preview concurrency is keyed by pull-request number and queues updates without canceling an in-progress `pulumi up`. Staging and production also use non-canceling deployment queues so an update is never interrupted. The close workflow shares the pull-request concurrency group and waits for any preview update to finish before destroying the stack.

Pulumi Cloud trusts GitHub OIDC tokens only for immutable repository ID `1095528250`, owner ID `136263`, and repository `rohanprabhu/windrun-ai`. GCP uses separate Workload Identity pools/providers and service accounts for production, staging, preview, edge, and foundation operations. Production trust accepts only the `main` branch workflow. Staging trust accepts only the `staging` branch workflow. Preview trust accepts same-repository pull-request workflows and receives only Cloud Run, Artifact Registry write, and runtime-service-account impersonation permissions in the staging project. Pull requests from forks run uncredentialed tests only and cannot deploy. Workflows never use `pull_request_target` to execute pull-request code. No CI identity receives a static Google service-account key.

The Pulumi account is currently an unclaimed agent account. Code and local bootstrap deployment may proceed during its 72-hour write window, but durable Pulumi Cloud OIDC policy and fully qualified CI stack names are enabled only after the user claims the account with `rohan@windrun.ai` and the agent authenticates to the transferred account. Claiming invalidates the ephemeral credential, so this is an explicit final-bootstrap checkpoint rather than an implicit background step.

## Secrets

- Google local provisioning uses Application Default Credentials created by the exact account `rohan@windrun.ai`.
- CI obtains short-lived GCP credentials through Workload Identity Federation.
- CI obtains short-lived Pulumi Cloud credentials through `pulumi/auth-actions` and the Pulumi OIDC issuer managed by the foundation stack.
- The DigitalOcean PAT has exactly `domain:create`, `domain:read`, `domain:update`, and `domain:delete`, expires in 90 days, and is used only by the foundation stack.
- The PAT is temporarily encrypted in macOS Keychain service `com.windrun.pulumi.digitalocean`. It is moved into encrypted Pulumi stack configuration when the foundation stack is initialized, then the temporary Keychain item is deleted.
- No token, service-account JSON key, plaintext stack secret, or `.env` credential is committed.

## Failure Handling and Observability

- Application build, lint, typecheck, unit tests, and infrastructure unit tests must pass before any `pulumi up`.
- Deployment workflows run `pulumi preview` before `pulumi up` and serialize updates by target stack.
- A failed image build cannot update Cloud Run because the service consumes the resulting immutable digest.
- A failed Cloud Run rollout leaves the previous healthy revision available until Pulumi reports the resource failure.
- Preview deployment performs a bounded HTTPS smoke-test with retry while DNS, certificate, and Cloud Run propagation settle; failure is reported on the pull request.
- The app emits structured request logs to stdout. Cloud Run automatically captures them in Cloud Logging.
- `/api/health` is used for container and post-deployment smoke tests. Serverless NEG backends do not use Compute Engine health checks.
- Pulumi stack outputs include public URL, project ID, service name, image digest, global IP, and certificate status where applicable; secrets are never stack outputs.

## Testing Strategy

1. Unit-test environment metadata normalization and API response schemas.
2. Component-test the status panel, latency interaction, accessibility labels, and reduced-motion behavior.
3. Build the Next.js standalone output and run a container-level health check locally.
4. Use Pulumi mocks to assert exact project ownership, provider selection, IAM boundaries, DNS names, URL-mask value, fixed service names, and stack-kind validation.
5. Run `pulumi preview` for foundation, both edge stacks, both primary app stacks, and a sample `pr-1` preview stack.
6. Deploy foundation and primary stacks, then verify DNS delegation, managed certificates, HTTP redirect, direct `run.app` ingress rejection, and the three public routes.
7. Create and destroy a real sample preview stack to prove the staging edge remains unchanged and the preview hostname begins and ceases serving as expected.

## Teardown

Teardown is intentionally ordered and wrapped by scripts that invoke Pulumi only:

1. Destroy all `pr-*` stacks and remove their empty Pulumi stacks.
2. Destroy `staging` and `production` application stacks.
3. Destroy `staging-edge` and `production-edge`.
4. Set foundation config `allowProjectDeletion=true`, preview the resulting deletion-policy change, then destroy `foundation`. It removes delegated DNS records, Cloud DNS, certificates, reserved IPs, registries, IAM/federation, and finally schedules all three GCP projects for deletion.

Project resources use deletion policy `PREVENT` while `allowProjectDeletion=false` and `DELETE` only during the acknowledged full teardown. The foundation destroy script requires an explicit `--destroy-projects` acknowledgement and verifies that no application, preview, or edge stacks still contain resources. Project deletion is the final recovery boundary; deleted projects enter Google Cloud `DELETE_REQUESTED` state and retain a 30-day recovery window, while their project IDs remain permanently unavailable for reuse.

## Non-Goals

- No database, persistent user accounts, or application secrets.
- No multi-region Cloud Run deployment in the initial version.
- No Cloud CDN or Cloud Armor until traffic or security requirements justify them.
- No per-preview load balancers, IP addresses, DNS records, or certificates.
- No manual resource creation in Google Cloud or DigitalOcean consoles.

## Primary References

- [Cloud Run custom domains](https://docs.cloud.google.com/run/docs/mapping-custom-domains)
- [Serverless NEG URL masks and limitations](https://docs.cloud.google.com/load-balancing/docs/negs/serverless-neg-concepts)
- [Global external HTTPS load balancer with Cloud Run](https://docs.cloud.google.com/load-balancing/docs/https/setup-global-ext-https-serverless)
- [Certificate Manager DNS authorization](https://docs.cloud.google.com/certificate-manager/docs/domain-authorization)
- [Google Workload Identity Federation for deployment pipelines](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
- [Pulumi GitHub Actions and OIDC](https://www.pulumi.com/docs/iac/operations/continuous-delivery/github-actions/)
- [DigitalOcean custom-scoped personal access tokens](https://docs.digitalocean.com/reference/api/create-personal-access-token/)
