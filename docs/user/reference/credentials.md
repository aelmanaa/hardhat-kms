---
title: Credentials reference
description: "Where hardhat-kms gets cloud credentials: the sources AWS, Google Cloud and Azure try, in order, with every variable they read."
---

# Credentials reference

Audience: Users who need to know which credentials sign, and which variables and files change them. For an overview by environment (a laptop, CI, a server), read [How the plugin reaches your cloud](../explanation/cloud-access.md) first.

No secrets live in the Hardhat config. On AWS and Google Cloud the plugin passes no credentials, so the cloud's SDK walks its own chain of sources and uses the first one that is configured. On Azure the plugin builds the chain listed below. The lists give the order in which sources are tried.

## AWS

1. Access keys in the environment: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, with `AWS_SESSION_TOKEN` for temporary keys. Skipped today whenever a profile is set; see below.
2. The profile in `~/.aws/config` and `~/.aws/credentials` named by the key's `profile`, else by `AWS_PROFILE`, else `default`. A profile can hold access keys, an SSO session (`aws sso login`), an `aws login` session, a role to assume, a `credential_process` command or a web identity token file.
3. A web identity token: `AWS_WEB_IDENTITY_TOKEN_FILE` with `AWS_ROLE_ARN`, as EKS sets for IAM roles for service accounts.
4. Container credentials when `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` or `AWS_CONTAINER_CREDENTIALS_FULL_URI` is set (an ECS task role, EKS Pod Identity). Otherwise the EC2 instance role, unless `AWS_EC2_METADATA_DISABLED` is set. The SDK asks the instance metadata service with IMDSv2 first and falls back to IMDSv1 when the IMDSv2 token request fails for any reason other than HTTP 400 (AWS documents 403, 404 and 405; the SDK also falls back on a timeout), unless `AWS_EC2_METADATA_V1_DISABLED=true` or the profile's `ec2_metadata_v1_disabled = true` is set ([IMDS credential provider](https://docs.aws.amazon.com/sdkref/latest/guide/feature-imds-credentials.html); checked in `@smithy/credential-provider-imds` 4.5.2). On EC2, require IMDSv2 on the instance (`HttpTokens=required`), as AWS recommends ([Transition to IMDSv2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-metadata-transition-to-version-2.html)), or set `AWS_EC2_METADATA_V1_DISABLED=true`.

**Never set a profile and environment keys together.** Today a profile skips the environment keys: when a key sets `profile`, or `AWS_PROFILE` is set, the AWS SDK for JavaScript ignores `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (checked with `@aws-sdk/credential-provider-node` 3.972.84). If both are set, it prints a warning once per process. The warning names `AWS_PROFILE` even when the profile comes from the key's `profile`, and it says that a future version may prefer the environment keys instead. A run that sets both could then sign as another identity after an SDK update. A CI job that exports keys, as `aws-actions/configure-aws-credentials` does, looks for the profile instead. It finds none and fails, or signs as whatever identity a later source returns, such as the runner's instance role. Keep a literal `profile` out of a config that CI runs. Either set `AWS_PROFILE` on the laptop instead, or take `profile` from a configuration variable with `default: ""`, which CI leaves unset ([One config for a laptop and CI](../guides/aws-kms-setup.md#one-config-for-a-laptop-and-ci)). Foundry differs here: the AWS SDK for Rust uses the environment keys even when `AWS_PROFILE` is set.

**An alias or a bare key id names a key in the credentials' own account and in the key's region.** That region is the one in a key ARN, then the key's `region`, then `kms.defaults.aws.region`, then the SDK's own (`AWS_REGION`, then the profile's region). The AWS KMS API reaches another account's key only through a key ARN or an alias ARN. Other credentials, or another region, can therefore find a different key under the same alias, and sign with it. An [`address` pin](configuration.md#configuration) catches this: the plugin refuses to sign when the key derives to another address. A key ARN fixes both the account and the region.

Each AWS key can set its own `profile`, so the keys of one run can sign with different credentials. `--kms aws` keys have no `profile` of their own and follow `AWS_PROFILE`.

## Google Cloud

Application Default Credentials (ADC):

1. The JSON file named by `GOOGLE_APPLICATION_CREDENTIALS`: a workload identity federation config (`external_account`) such as the one `google-github-actions/auth` writes, or a service account key, which Google does not recommend ([How Application Default Credentials works](https://docs.cloud.google.com/docs/authentication/application-default-credentials)). If the variable names a file that is missing or cannot be read, the run fails; ADC does not fall back to the next source.
2. `application_default_credentials.json`, which `gcloud auth application-default login` writes, in the directory named by `CLOUDSDK_CONFIG`, else `~/.config/gcloud` (`%APPDATA%\gcloud` on Windows). Signing in with `--impersonate-service-account` makes it an impersonated service account.
3. The metadata server, on Google Cloud: the service account attached to the VM, GKE workload or Cloud Run service.

Either file can hold a user, an impersonated service account, an `external_account` config or a service account key. Prefer the first three: [Set up a Google Cloud KMS key](../guides/gcp-kms-setup.md#2-allow-signing-and-nothing-else) says which to use where. `GOOGLE_CLOUD_QUOTA_PROJECT` sets the quota project. The plugin does not use the account of `gcloud auth login`, nor gcloud settings such as `auth/impersonate_service_account`.

## Azure

The plugin builds its own chain rather than `DefaultAzureCredential`, in the order proposed for Foundry's Azure Key Vault signer in [foundry-rs/foundry#17120](https://github.com/foundry-rs/foundry/pull/17120). No Foundry release includes that signer yet. Contributors: [Cloud access and credentials](../../contributor/architecture.md#cloud-access-and-credentials) in the architecture docs shows the code.

1. A service principal from the environment, which the plugin selects itself with the rules of @azure/identity's `EnvironmentCredential`. With `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` set, it signs in with the secret (`ClientSecretCredential`). Otherwise, with `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_CERTIFICATE_PATH` set, it signs in with the PEM certificate in that file (`ClientCertificateCredential`), unlocked with `AZURE_CLIENT_CERTIFICATE_PASSWORD` when that is set. The secret wins over the certificate, and an empty variable counts as unset. `AZURE_CLIENT_SEND_CERTIFICATE_CHAIN` set to `true` or `1` sends the certificate chain, for subject name and issuer authentication. `AZURE_ADDITIONALLY_ALLOWED_TENANTS`, a `;`-separated list of tenant ids or `*`, lets the service principal get tokens for a vault in a tenant other than `AZURE_TENANT_ID`. `AZURE_AUTHORITY_HOST` sets the sign-in endpoint for another Azure cloud. An `AZURE_TENANT_ID` with a character other than a letter, a digit, `-` or `.` fails with `azure.credential.tenant-id`. Prefer a federated credential (workload identity, or OIDC in CI) or a certificate over a secret: Microsoft's [security best practices for app registration](https://learn.microsoft.com/en-us/entra/identity-platform/security-best-practices-for-app-registration) say to use certificate credentials when a managed identity or another external identity provider is not possible, and not to use secrets.
2. `WorkloadIdentityCredential`, when `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_FEDERATED_TOKEN_FILE` are set, as AKS sets them for workload identity.
3. `AzureCliCredential` (`az login`, or the `azure/login` action in GitHub Actions), then `AzureDeveloperCliCredential` (`azd auth login`).
4. `ManagedIdentityCredential`, user-assigned when `AZURE_CLIENT_ID` is set.

`AZURE_CLIENT_ID` selects a user-assigned managed identity. The managed identity has 10 s to return a token, after which it counts as unavailable, and each of its HTTP requests times out after 3 s. @azure/identity does not pass an abort signal on to those requests, so the request timeout is what ends one to an endpoint that never answers and lets `hardhat run` exit. Where the managed identity refuses a client id (Azure Cloud Shell, Service Fabric), it is left out of the chain. A source that is not configured is skipped; a configured source that fails, such as a service principal with a wrong secret, stops the chain with its error. All Azure keys of a run share the chain and its tokens, so `az login` users see one `az` call per run, not one per key. See [Set up an Azure Key Vault key](../guides/azure-key-vault-setup.md#3-sign-in).

**No username and password sign-in.** With `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_USERNAME` and `AZURE_PASSWORD` set and no secret or certificate, `EnvironmentCredential` would sign in as that user with the password alone. That sign-in cannot do multifactor authentication, Microsoft has deprecated it, and with it a leaked password would be enough to sign. The plugin refuses it: signing and `kms history` fail with `azure.credential.username-password` before any source is asked for a token, even when `az login` or workload identity would have worked. The message names the variables, never their values. Unset `AZURE_USERNAME` and `AZURE_PASSWORD`, or set a secret or certificate.

In every other case the plugin ignores `AZURE_USERNAME` and `AZURE_PASSWORD` and writes one `hardhat:kms:azure` debug line that names them. Such cases include a stray `AZURE_USERNAME` next to `az login`, and both variables next to a client secret. The rest of the chain works as described above.

## One identity per run on Google Cloud and Azure

Only AWS keys can choose their credentials, with `profile`. No config field selects a credential on Google Cloud or Azure: every Google Cloud key of a run signs as the ADC identity, and every Azure key as the first source in the Azure chain that returns a token. `kms history` reads with the same identity. To sign as two identities, run Hardhat twice with different environments.
