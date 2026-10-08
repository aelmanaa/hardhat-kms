---
title: Sign from GitHub Actions with OIDC
description: Let a GitHub Actions job sign with an AWS KMS, Google Cloud KMS or Azure Key Vault key over OIDC, with no cloud credential stored in GitHub.
---

# Sign from GitHub Actions with OIDC

This guide sets up a GitHub Actions job that deploys or signs with a KMS key, with credentials the cloud issues for that job alone, and checks that the job can sign.

You need a key created with one of the setup guides, admin rights on the repository, and rights to create roles or identities in the key's cloud. No experience with OpenID Connect (OIDC) is assumed.

> [!NOTE]
> Audience: users who want a GitHub Actions job to deploy or sign with a KMS key that is already set up.
>
> Checked against each cloud's documentation on 2026-10-08. This repository's own [live-tests workflow](https://github.com/aelmanaa/hardhat-kms/blob/main/.github/workflows/live-tests.yml) signs in the same way, with one environment that has a required reviewer, a trust on that environment's subject in each cloud, and the same three login actions at the same commits; its run 37700159523 passed on all three clouds on 2026-10-07 (UTC). It installs with pnpm and runs tests. The cloud commands as written were not run for this page, and neither was the example workflow below, `kms accounts --check-sign` step included.

A GitHub Actions job can ask GitHub for a short-lived OIDC token that names the repository and the job's environment. Each cloud exchanges that token for short-lived credentials. GitHub stores no access key, client secret or service account key. The plugin then finds those credentials the same way it finds your own on a laptop ([Cloud credentials for KMS signing](../explanation/cloud-access.md#ci-with-oidc)).

| Cloud        | What trusts the job                                                          | What it may do                                                          |
| ------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| AWS          | An IAM role whose trust policy names the job's subject                       | `kms:Sign` and `kms:GetPublicKey` on the key                            |
| Google Cloud | The subject itself, as a principal of a workload identity pool               | `roles/cloudkms.signer` and `roles/cloudkms.publicKeyViewer` on the key |
| Azure        | A user-assigned managed identity with a federated credential for the subject | A role on the key with only its read and sign data actions              |

## 1. Find the subject your jobs send

Each cloud trusts one exact value of the token's `sub` claim, the subject. For a job that runs in an environment, GitHub's subject has one of two forms ([OIDC reference](https://docs.github.com/en/actions/reference/security/oidc#filtering-for-a-specific-environment)):

| Form      | Subject                                                              |
| --------- | -------------------------------------------------------------------- |
| Name      | `repo:<owner>/<repo>:environment:<environment>`                      |
| Immutable | `repo:<owner>@<owner id>/<repo>@<repo id>:environment:<environment>` |

The immutable form adds the numeric ids of the owner and the repository. A name can be reused after a rename or a deletion, but an id cannot, so a trust written for the immutable form never passes to another repository that takes the old name. Repositories created, renamed or transferred on github.com after 2026-07-15 send the immutable form. Older repositories send the name form until you opt in, per repository or per organization, in the OIDC settings or with the REST API ([Immutable subject claims](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims), [changelog](https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/)). GitHub Enterprise Server does not have it. Use the immutable form when your repository can send it.

Ask GitHub which form your repository sends:

```sh
gh api repos/<owner>/<repo>/actions/oidc/customization/sub
```

`sub_claim_prefix` is the subject up to the environment part, and `use_immutable_subject` says which form it is ([REST API for OIDC](https://docs.github.com/en/rest/actions/oidc#get-the-customization-template-for-an-oidc-subject-claim-for-a-repository)). If `use_default` is `false`, the repository or its organization sets a custom subject template, and the subject has the claims that template lists instead. The subject is `sub_claim_prefix`, then `:environment:` and the environment's name. The steps below use an environment named `deploy`.

The two ids are also on the repository's API page:

```sh
gh api repos/<owner>/<repo> --jq '.owner.id, .id'
```

Before you opt in, GitHub's preview endpoint shows the subject the repository would send in the immutable form ([changelog](https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/)). Trust the form the repository sends today. A trust for the other form refuses every token. When you switch a repository to the immutable form, add a trust for the new subject first, and remove the old one once a run passes.

## 2. Create an environment with required reviewers

The subject names the environment, so only a job that runs in that environment gets credentials. Protect the environment, since any workflow on any branch can name it:

1. In the repository's settings, open **Environments** and create `deploy` ([Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
2. Turn on **Required reviewers** and add the people who approve each run. Turn on **Prevent self-review** if more than one person can approve.
3. Under **Deployment branches and tags**, allow only the branches that may deploy, such as `main`.

A job that names the environment waits for a reviewer's approval, and it cannot read the environment's secrets before that ([Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers)). An approved run executes the code of its commit with the right to sign. Before approving a run of pull request code, read its diff, including changes to workflows, scripts and dependencies, and check that the run's commit is the one you read. Never give a signing environment to a `pull_request_target` or `workflow_run` job that checks out pull request code ([Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)).

Store the identifiers that the workflow needs as secrets of the environment, not of the repository. They are not credentials, but as secrets they are masked in the logs and reach only approved jobs. Step 3 says which ones each cloud needs; the key's identifier goes in `DEPLOYER_KEY` and the RPC URL in `SEPOLIA_RPC_URL`.

## 3. Trust the job in your cloud

Do the part for your key's cloud. Each grants the job only the two key permissions of the setup guide's "allow signing" step, on that one key: [AWS KMS](aws-kms-setup.md#2-allow-signing-and-nothing-else), [Google Cloud KMS](gcp-kms-setup.md#2-allow-signing-and-nothing-else), [Azure Key Vault](azure-key-vault-setup.md#2-allow-get-and-sign-and-nothing-else).

The examples use `<owner>`, `<repo>`, `<owner id>` and `<repo id>` from step 1. Replace them, and keep the environment's name in the subject.

### AWS

Add GitHub as an OIDC identity provider of the AWS account, once per account. AWS checks GitHub's certificate against its trusted root CAs, so no thumbprint is needed ([create-open-id-connect-provider](https://docs.aws.amazon.com/cli/latest/reference/iam/create-open-id-connect-provider.html)):

```sh
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

Save the role's trust policy as `trust-policy.json`. It accepts a token only for the audience `sts.amazonaws.com` and the one subject ([Configuring a role for GitHub OIDC identity provider](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html#idp_oidc_Create_GitHub)):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:<owner>@<owner id>/<repo>@<repo id>:environment:deploy"
        }
      }
    }
  ]
}
```

Replace `111122223333` with your account id. A repository that sends the name form needs the subject `repo:<owner>/<repo>:environment:deploy`. Keep `StringEquals` with the full subject. IAM refuses a trust policy for GitHub whose `sub` condition is missing or only a wildcard, and AWS recommends limiting it to specific repositories ([same page](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html#idp_oidc_Create_GitHub)).

Create the role. Then attach to it `hardhat-kms-deployer`, the signing policy from the [AWS setup guide](aws-kms-setup.md#2-allow-signing-and-nothing-else):

```sh
aws iam create-role \
  --role-name hardhat-kms-deploy \
  --assume-role-policy-document file://trust-policy.json

aws iam attach-role-policy --role-name hardhat-kms-deploy --policy-arn <Arn of the hardhat-kms-deployer policy>
```

Environment secrets for the workflow: `AWS_ROLE_ARN`, the `Role.Arn` that `create-role` prints, and `DEPLOYER_KEY`, the key ARN. The key's region goes in `AWS_REGION`, a variable (not a secret) of the `deploy` environment, under Environments, deploy, Environment variables, since the workflow reads it as `vars.AWS_REGION`.

### Google Cloud

Grant the key's roles straight to the job's subject, as a principal of a workload identity pool. No service account is needed, and none is impersonated: Cloud KMS supports such principals, and so does Cloud Logging, for `kms history` ([supported services](https://docs.cloud.google.com/iam/docs/federated-identity-supported-services)).

Enable the four APIs that Google's guide lists, in the key's project. Enabling an API grants no permission. No step of this setup calls the IAM Service Account Credentials API (`iamcredentials.googleapis.com`), which serves service account impersonation, but Google's guide lists it, so enable it too ([Workload Identity Federation with deployment pipelines](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)):

```sh
gcloud services enable iam.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com \
  iamcredentials.googleapis.com --project my-project
```

Create a pool and a provider for GitHub's issuer. GitHub uses one issuer for every repository, so Google requires an attribute condition that limits the provider to your tokens ([same page](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)). This one checks the owner and repository by id, and the environment:

```sh
gcloud iam workload-identity-pools create github \
  --project my-project \
  --location global \
  --display-name "GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc deploy-jobs \
  --project my-project \
  --location global \
  --workload-identity-pool github \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.environment=assertion.environment" \
  --attribute-condition "assertion.repository_owner_id == '<owner id>' && assertion.repository_id == '<repo id>' && assertion.environment == 'deploy'"
```

`google.subject` holds the token's subject, which can be at most 127 characters ([Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation)). The two other mapped attributes are not used by the binding below; they let you bind a `principalSet://iam.googleapis.com/projects/<project number>/locations/global/workloadIdentityPools/github/attribute.repository_id/<repo id>` member instead, for example when a long owner or repository name makes the subject longer than 127 characters. With such a member, the attribute condition still limits the provider to the `deploy` environment. Grant the two roles on the key to that subject. The member names the pool by the project's number, which `gcloud projects describe my-project --format='value(projectNumber)'` prints:

```sh
MEMBER="principal://iam.googleapis.com/projects/<project number>/locations/global/workloadIdentityPools/github/subject/repo:<owner>@<owner id>/<repo>@<repo id>:environment:deploy"

for role in roles/cloudkms.publicKeyViewer roles/cloudkms.signer; do
  gcloud kms keys add-iam-policy-binding deployer \
    --project my-project \
    --keyring deployer-ring \
    --location europe-west1 \
    --member "$MEMBER" \
    --role "$role"
done
```

Signing needs nothing else: no project-level role and no `resourcemanager.projects.get`, since the plugin passes the project named in the key's `keyVersionName` to Google's client libraries ([Google Cloud setup guide](gcp-kms-setup.md#2-allow-signing-and-nothing-else)). For `kms history` in the job, also grant `roles/logging.privateLogViewer` on the project to the same member. That role reads every Data Access log of the project, not only the key's entries ([Allow reading the logs](gcp-kms-setup.md#allow-reading-the-logs)).

Environment secrets for the workflow: `GCP_WORKLOAD_IDENTITY_PROVIDER`, the provider's full name, and `DEPLOYER_KEY`, the key's `keyVersionName`. Print the provider's name with:

```sh
gcloud iam workload-identity-pools providers describe deploy-jobs \
  --project my-project --location global --workload-identity-pool github --format='value(name)'
```

### Azure

Create a user-assigned managed identity, and give it a federated credential for the job's subject. Microsoft Entra compares the subject exactly and accepts no wildcard; a wrong subject is accepted when you create the credential and only fails at sign-in ([Create trust between a user-assigned managed identity and an external identity provider](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-user-assigned-managed-identity)):

```sh
az identity create --resource-group my-rg --name hardhat-kms-deploy

az identity federated-credential create \
  --resource-group my-rg \
  --identity-name hardhat-kms-deploy \
  --name github-deploy \
  --issuer https://token.actions.githubusercontent.com \
  --subject "repo:<owner>@<owner id>/<repo>@<repo id>:environment:deploy" \
  --audiences api://AzureADTokenExchange
```

Assign the identity the Key Vault Ethereum Signer role from the [Azure setup guide](azure-key-vault-setup.md#vaults-that-use-azure-rbac), on the key alone. A managed identity's principal type is `ServicePrincipal`:

```sh
az role assignment create \
  --role "Key Vault Ethereum Signer" \
  --assignee-object-id "$(az identity show --resource-group my-rg --name hardhat-kms-deploy --query principalId --output tsv)" \
  --assignee-principal-type ServicePrincipal \
  --scope "$(az keyvault show --name my-vault --query id --output tsv)/keys/deployer"
```

For a vault that uses access policies, grant `get` and `sign` to the same principal id instead ([Vaults that use access policies](azure-key-vault-setup.md#vaults-that-use-access-policies)).

Environment secrets for the workflow: `AZURE_CLIENT_ID`, from `az identity show --resource-group my-rg --name hardhat-kms-deploy --query clientId --output tsv`, `AZURE_TENANT_ID`, from `az account show --query tenantId --output tsv`, and `DEPLOYER_KEY`, the key's versioned URL. The identity has no role on the subscription, so the workflow signs in with `allow-no-subscriptions` and needs no subscription id.

## 4. Configure the key for CI

Read the key from a configuration variable, which the workflow fills from the environment's secret. Pin the key's `address`: run `npx hardhat kms accounts` once and paste the `address` line it prints.

::: code-group

```ts [AWS KMS]
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAws from "@hardhat-kms/aws";

export default defineConfig({
  plugins: [hardhatKmsAws],
  kms: {
    keys: {
      // No `profile`: the job's credentials come from the environment, and a profile would make
      // the AWS SDK skip them.
      deployer: { provider: "aws", keyId: configVariable("DEPLOYER_KEY") },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
  },
});
```

```ts [Google Cloud KMS]
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsGcp from "@hardhat-kms/gcp";

export default defineConfig({
  plugins: [hardhatKmsGcp],
  kms: {
    keys: {
      deployer: { provider: "gcp", keyVersionName: configVariable("DEPLOYER_KEY") },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
  },
});
```

```ts [Azure Key Vault]
import { configVariable, defineConfig } from "hardhat/config";
import hardhatKmsAzure from "@hardhat-kms/azure";

export default defineConfig({
  plugins: [hardhatKmsAzure],
  kms: {
    keys: {
      deployer: { provider: "azure", keyId: configVariable("DEPLOYER_KEY") },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      kmsAccounts: ["deployer"],
    },
  },
});
```

:::

An AWS key that uses a profile on your laptop can take it from a configuration variable that CI leaves empty: see [One config for a laptop and CI](aws-kms-setup.md#one-config-for-a-laptop-and-ci).

## 5. Add the workflow

Save this as `.github/workflows/deploy.yml`. It runs when you start it from the Actions tab, waits for a reviewer, installs and builds, signs in to the cloud, checks that the key can sign, then runs your deploy script. Keep the sign-in step of your key's cloud and delete the other two, with their secrets.

```yaml
name: Deploy

on:
  workflow_dispatch:

permissions: {}

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: deploy
    permissions:
      contents: read
      id-token: write # lets the job request the OIDC token
    steps:
      # Every step of this job can request an OIDC token, so no dependency install script runs
      # here (--ignore-scripts), and no dependency cache is restored. Installing and building
      # before the sign-in steps keeps the credentials they export out of the install and the
      # compiler download.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
          package-manager-cache: false # setup-node caches npm when package.json names it
      - run: npm ci --ignore-scripts
      - run: npx hardhat build

      # AWS KMS
      - uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}
          mask-aws-account-id: true

      # Google Cloud KMS: direct workload identity federation, no service account.
      - uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3.0.0
        with:
          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}

      # Azure Key Vault: signs the Azure CLI in, which the plugin then uses.
      - uses: azure/login@a641126d1b8aa4d1fa005f4f92df94a3a4c4c906 # v3.1.0
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          allow-no-subscriptions: true

      - name: Check that the key signs
        env:
          DEPLOYER_KEY: ${{ secrets.DEPLOYER_KEY }}
          SEPOLIA_RPC_URL: ${{ secrets.SEPOLIA_RPC_URL }}
        run: npx hardhat --network sepolia kms accounts --balances --check-sign

      - name: Deploy
        env:
          DEPLOYER_KEY: ${{ secrets.DEPLOYER_KEY }}
          SEPOLIA_RPC_URL: ${{ secrets.SEPOLIA_RPC_URL }}
        run: npx hardhat run --network sepolia scripts/deploy.ts
```

What each part does:

- `id-token: write` applies to every step of the job: GitHub gives each step what it needs to request a token, and a token from this job is one the cloud trusts ([OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)). So `npm ci --ignore-scripts` keeps dependency install scripts from running, which the plugin's dependencies do not need ([Install hardhat-kms](install-before-release.md)), and the job uses no dependency cache that another run could have written. To run install scripts, install and build in a separate job without `id-token` and pass the result on as an artifact.
- `permissions` at the top gives the workflow's other jobs nothing. Only this job may request an OIDC token (`id-token: write`) and read the code (`contents: read`) ([Configuring OpenID Connect in Amazon Web Services](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)).
- Each action is pinned to a full commit SHA, with its version in a comment. GitHub calls this "the only way to use an action as an immutable release" ([Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)). Check each SHA against the action's own repository when you update it.
- `aws-actions/configure-aws-credentials` exports temporary access keys and `AWS_REGION`. The plugin's AWS SDK picks them up as long as no profile is set.
- `google-github-actions/auth` writes an `external_account` credentials file named `gha-creds-*.json` in the workspace and points `GOOGLE_APPLICATION_CREDENTIALS` at it. The file holds no key, but it lets a step exchange the job's token while the job runs. Check out before this step, as here, so the checkout does not remove the file, and never upload the workspace as an artifact or commit from it ([google-github-actions/auth](https://github.com/google-github-actions/auth)).
- `azure/login` runs the Azure CLI's sign-in with the federated token and sets no `AZURE_*` variables, so the plugin signs through the Azure CLI. Keep `AZURE_CLIENT_SECRET` and `AZURE_CLIENT_CERTIFICATE_PATH` out of the job: a service principal in the environment comes first in the plugin's order ([Credentials](../reference/credentials.md#azure)).
- `DEPLOYER_KEY` and `SEPOLIA_RPC_URL` reach only the two steps that use them.

Start a run from the Actions tab, or with `gh workflow run deploy.yml`, and approve it when the environment asks.

## 6. Check that the job can sign

The `Check that the key signs` step runs [`kms accounts --check-sign`](../reference/tasks.md#check-keys-before-a-deploy) before anything is sent. The key signs a random message and the plugin checks that the signature recovers to the key's address, so a passing row proves that the job's credentials may sign, not only read the public key. `--balances` adds the account's balance on the network. A row reads like this:

```text
NAME                    PROVIDER  SOURCE       ADDRESS                                     PIN      BALANCE (ETH)  SIGN  KEY ID
sepolia.kmsAccounts[0]  aws       kmsAccounts  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  matches  0.25           ok    aws:<DEPLOYER_KEY>
```

The key id shows as the name of its configuration variable, so the log does not print it. If any row fails, the command exits with code 1 and the deploy step does not run.

## Common failures

| Symptom                                                                                                              | Cause and fix                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AWS sign-in fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity`                                     | The token's subject or audience differs from the trust policy. Compare the policy's `sub` with step 1, character for character, and check that the job names the environment.                                                                                                                                |
| Google Cloud signing fails with `the token exchange refused the external credentials (invalid_grant)`                | The token does not match the provider's attribute condition, or the provider expects another audience. Check the condition's ids and environment name, and that the workflow's input names this provider.                                                                                                    |
| Google Cloud signing fails with `permission denied (PERMISSION_DENIED)`                                              | The token exchange worked, but the key's bindings name another subject. Compare the member's subject after `/subject/` with step 1, and check that both roles are on this key.                                                                                                                               |
| Azure sign-in fails with `AADSTS700213: No matching federated identity record found for presented assertion subject` | The federated credential's subject differs from the token's. Compare the subject the error quotes with the credential's `subject`, character for character.                                                                                                                                                  |
| Azure sign-in fails with `AADSTS700211`, no matching record for the assertion issuer                                 | The federated credential's issuer is not exactly `https://token.actions.githubusercontent.com`.                                                                                                                                                                                                              |
| Azure sign-in fails with `AADSTS70021: No matching federated identity record found for presented assertion`          | The federated credential was created a few minutes ago and has not propagated yet. Wait and run again ([considerations](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-considerations)).                                                                                   |
| Azure sign-in fails with `AADSTS700212`, no matching record for the assertion audience                               | The `audience` input of `azure/login` differs from the federated credential's audience. Leave both at `api://AzureADTokenExchange`, the default ([Authenticate to Azure from GitHub Actions by OpenID Connect](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect)). |
| Every cloud refuses the token, and the job never waited for approval                                                 | The job does not name the environment, so its subject ends in `:ref:refs/heads/<branch>` or `:pull_request` instead. Add `environment: deploy` to the job. A pull request from a fork gets no OIDC token at all.                                                                                             |
| A sign-in step fails because an input such as `role-to-assume` is empty                                              | The secret is missing from the environment, or was set as a repository secret under another name. Environment secrets reach only jobs that name the environment.                                                                                                                                             |
| The subject looks right and is still refused                                                                         | The repository sends the other subject form. Compare with `sub_claim_prefix` from step 1; a rename or a transfer after 2026-07-15 switches the repository to the immutable form.                                                                                                                             |
| AWS signs as another identity, or finds no credentials                                                               | The config or the job sets a profile (`profile` on the key, or `AWS_PROFILE`), so the AWS SDK skips the exported keys ([Credentials](../reference/credentials.md#aws)).                                                                                                                                      |
| Azure signs as another identity                                                                                      | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` (or a certificate path) are set in the job, so a service principal wins over the Azure CLI. Remove them.                                                                                                                                      |
| Google Cloud signing fails with `the provider call failed (Error)` before any Cloud KMS call                         | A `@hardhat-kms/gcp` build older than 0.9.0 looked the project up through Cloud Resource Manager, which the federated identity may not call. Upgrade to 0.9.0 or later; it passes the key's project and makes no lookup.                                                                                     |

For an error that the plugin itself reports, look it up in [Errors](../reference/errors.md) by its id or a fixed part of its message.

## Read next

- [Cloud credentials for KMS signing](../explanation/cloud-access.md): which credential source each cloud uses in CI.
- [Credentials reference](../reference/credentials.md): every variable that changes the identity that signs.
- [Find who signed with a key](who-signed.md): read the key's sign events, including the job's, from the cloud's audit log. To run `kms history` in the job, also grant the read permission of your cloud's setup guide: [AWS](aws-kms-setup.md#the-read-permission), [Google Cloud](gcp-kms-setup.md#allow-reading-the-logs), [Azure](azure-key-vault-setup.md#the-read-permission).
- [Deploy with Hardhat Ignition](deploy-with-ignition.md): a deploy script to run in the job.
