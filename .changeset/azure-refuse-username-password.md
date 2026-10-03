---
"@hardhat-kms/azure": minor
"hardhat-kms": minor
---

The Azure credential chain no longer signs in with `AZURE_USERNAME` and `AZURE_PASSWORD`. That sign-in cannot do multifactor authentication, so a leaked password would be enough to sign. The plugin now selects the service principal from the environment itself, with the rules of @azure/identity's `EnvironmentCredential`, in place of that class. With `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_USERNAME` and `AZURE_PASSWORD` set and no client secret or certificate, signing and `kms history` fail with the new `azure.credential.username-password` error, which names the variables but not their values. A setup that signed in that way stops working: set `AZURE_CLIENT_SECRET` or `AZURE_CLIENT_CERTIFICATE_PATH`, or unset the two variables and use `az login`, workload identity or a managed identity. A stray `AZURE_USERNAME` or `AZURE_PASSWORD` in any other case is ignored, with a `hardhat:kms:azure` debug line that names it, so `az login` and service principal setups keep working.

`AZURE_ADDITIONALLY_ALLOWED_TENANTS` now takes effect for a service principal from the environment, so a vault in an allowed tenant other than `AZURE_TENANT_ID` can sign. Before, `EnvironmentCredential` passed it under an option name that no credential reads, and the variable had no effect. A service principal that fails for any reason, including a tenant that is not allowed, still stops the chain instead of falling through to `az login`. An invalid `AZURE_TENANT_ID` now fails with `azure.credential.tenant-id` instead of a generic adapter error.

`hardhat-kms/provider-utils` now exports `kmsDebug`, the `hardhat:kms:*` debug logger that prints plain values only. It refuses a namespace other than lowercase letters, digits and `-`.
