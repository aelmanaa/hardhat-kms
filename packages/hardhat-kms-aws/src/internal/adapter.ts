import type {
  GetPublicKeyCommand,
  KMSClient,
  KMSClientConfig,
  SignCommand,
} from "@aws-sdk/client-kms";
import {
  catalogError,
  type ErrorEntry,
  parseAwsKeyId,
  publicKeyFromSpkiDer,
  type TemplateParams,
} from "hardhat-kms/provider-utils";
import type {
  AwsKmsKeyConfig,
  KmsKeyAdapter,
  SignatureOutput,
  SignContext,
} from "hardhat-kms/types";

import { awsClientSettings } from "./client-settings.ts";
import { ERRORS } from "./error-catalog.ts";

const KEY_SPEC = "ECC_SECG_P256K1";
const KEY_USAGE = "SIGN_VERIFY";
const SIGNING_ALGORITHM = "ECDSA_SHA_256";

/** The entries of the AWS KMS errors explained by their name alone; none has a placeholder. */
type ServiceEntry = (typeof ERRORS)["disabled" | "invalidState" | "unavailable" | "expiredToken"];

/** AWS KMS errors explained by their name alone. */
const SERVICE_ERRORS: ReadonlyMap<string, ServiceEntry> = new Map<string, ServiceEntry>([
  ["DisabledException", ERRORS.disabled],
  ["KMSInvalidStateException", ERRORS.invalidState],
  ["KeyUnavailableException", ERRORS.unavailable],
  ["ExpiredTokenException", ERRORS.expiredToken],
]);

/** The entries of the credential failures the adapter explains; none has a placeholder. */
type CredentialEntry = (typeof ERRORS)[
  | "noCredentials"
  | "ssoSession"
  | "loginSession"
  | "mfaRequired"];

/**
 * Fixed phrases of the AWS SDK's credential provider messages (credential-provider-node, -ini,
 * -sso, -login and token-providers), each with the error it stands for. The rest of those messages
 * names profiles, sessions and file paths, so only these phrases are read, and none is shown.
 */
const CREDENTIAL_MARKERS: ReadonlyArray<readonly [marker: string, entry: CredentialEntry]> = [
  // credential-provider-node, when no source in the default chain has credentials.
  ["Could not load credentials from any providers", ERRORS.noCredentials],
  // credential-provider-sso and token-providers: no cached SSO token, or an expired one.
  ["To refresh this SSO session run", ERRORS.ssoSession],
  // credential-provider-login: no cached `aws login` token, or one that cannot be refreshed.
  ["Failed to load token from", ERRORS.loginSession],
  ["re-authenticate using", ERRORS.loginSession],
  // credential-provider-ini: a role profile with mfa_serial, and no MFA code callback.
  ["requires multi-factor authentication", ERRORS.mfaRequired],
];

/** What a region looks like, such as `eu-west-1` or `us-gov-west-1`; anything else is not shown. */
const REGION = /^[a-z0-9]+(?:-[a-z0-9]+){1,4}$/;

/** The parts of @aws-sdk/client-kms the adapter uses; tests pass a fake with the same shape. */
export interface AwsKmsSdk {
  KMSClient: new (config: KMSClientConfig) => Pick<KMSClient, "send" | "destroy" | "config">;
  GetPublicKeyCommand: typeof GetPublicKeyCommand;
  SignCommand: typeof SignCommand;
}

type KmsClient = InstanceType<AwsKmsSdk["KMSClient"]>;

/**
 * The AWS KMS adapter for one key.
 *
 * It signs 32-byte digests with `MessageType: DIGEST`, so KMS signs the digest as given instead of
 * hashing it again. It learns the key ARN from `GetPublicKey` and signs with that ARN, never with
 * an alias, so an alias that is repointed later cannot switch keys between the address lookup and
 * a signature.
 */
class AwsKeyAdapter implements KmsKeyAdapter {
  readonly #key: AwsKmsKeyConfig;
  readonly #keyId: string;
  readonly #client: KmsClient;
  readonly #sdk: AwsKmsSdk;
  #keyArn: string | undefined;

  public constructor(key: AwsKmsKeyConfig, keyId: string, sdk: AwsKmsSdk, client: KmsClient) {
    this.#key = key;
    this.#keyId = keyId;
    this.#sdk = sdk;
    this.#client = client;
  }

  public describe(): { provider: string; pinnedId: string; displayId: string } {
    return { provider: "aws", pinnedId: this.#key.keyId.display, displayId: this.#key.displayId };
  }

  public async getPublicKey(ctx: SignContext): Promise<Uint8Array> {
    const response = await this.#send(
      "get public key",
      async () =>
        await this.#client.send(new this.#sdk.GetPublicKeyCommand({ KeyId: this.#keyId }), {
          abortSignal: ctx.signal,
        }),
    );
    // The checks below do not trust the SDK's types: every field of a response is optional.
    const keySpec = response.KeySpec;
    if (keySpec !== KEY_SPEC) {
      throw this.#error("get public key", ERRORS.keySpec, { keySpec: String(keySpec) });
    }
    const keyUsage = response.KeyUsage;
    if (keyUsage !== KEY_USAGE) {
      throw this.#error("get public key", ERRORS.keyUsage, { keyUsage: String(keyUsage) });
    }
    const algorithms: unknown = response.SigningAlgorithms;
    if (!Array.isArray(algorithms) || !algorithms.includes(SIGNING_ALGORITHM)) {
      throw this.#error("get public key", ERRORS.signingAlgorithm, {});
    }
    const keyArn = response.KeyId;
    if (typeof keyArn !== "string" || parseAwsKeyId(keyArn)?.kind !== "keyArn") {
      throw this.#error("get public key", ERRORS.noKeyArn, {});
    }
    const publicKey: unknown = response.PublicKey;
    if (!(publicKey instanceof Uint8Array)) {
      throw this.#error("get public key", ERRORS.noPublicKey, {});
    }
    const parsed = publicKeyFromSpkiDer(publicKey);
    // Keep the ARN only for a validated key from a call that was not abandoned, so a late answer
    // to a timed-out call cannot replace it.
    if (!ctx.signal.aborted) {
      this.#keyArn = keyArn;
    }
    return parsed;
  }

  public async signDigest(
    request: { digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput> {
    if (this.#keyArn === undefined) {
      // The signer always resolves the key first; this keeps the ARN rule if it ever does not.
      await this.getPublicKey(ctx);
    }
    const keyArn = this.#keyArn;
    if (keyArn === undefined) {
      // The lookup above was abandoned (its signal aborted): never sign without the ARN.
      throw this.#error("sign", ERRORS.lookupUnfinished, {});
    }
    const command = new this.#sdk.SignCommand({
      KeyId: keyArn,
      Message: request.digest,
      MessageType: "DIGEST",
      SigningAlgorithm: SIGNING_ALGORITHM,
    });
    const response = await this.#send(
      "sign",
      async () => await this.#client.send(command, { abortSignal: ctx.signal }),
    );
    if (response.KeyId !== keyArn) {
      throw this.#error("sign", ERRORS.responseKey, {});
    }
    if (response.SigningAlgorithm !== SIGNING_ALGORITHM) {
      throw this.#error("sign", ERRORS.responseAlgorithm, {});
    }
    const signature: unknown = response.Signature;
    if (!(signature instanceof Uint8Array)) {
      throw this.#error("sign", ERRORS.noSignature, {});
    }
    return { format: "der", bytes: signature };
  }

  /**
   * Runs a KMS call and explains the errors users can act on. Only an error's name and fixed
   * phrases of the SDK's own messages are read; the messages themselves are never shown, since
   * KMS messages hold key ARNs and account ids, and credential messages hold profile names and
   * file paths.
   */
  async #send<Output>(operation: string, send: () => Promise<Output>): Promise<Output> {
    try {
      return await send();
    } catch (error) {
      throw (await this.#explain(operation, error)) ?? error;
    }
  }

  async #explain(operation: string, error: unknown): Promise<Error | undefined> {
    if (!(error instanceof Error)) {
      return undefined;
    }
    // The SDK reports a missing region with a plain Error, which the signer would show only as
    // "Error". Its message holds no request details, so it is safe to recognise.
    if (error.message.includes("Region is missing")) {
      return this.#error("connect", ERRORS.noRegion, {});
    }
    if (error.name === "CredentialsProviderError") {
      const marked = CREDENTIAL_MARKERS.find(([marker]) => error.message.includes(marker));
      return marked === undefined ? undefined : this.#error("connect", marked[1], {});
    }
    const known = SERVICE_ERRORS.get(error.name);
    if (known !== undefined) {
      return this.#error(operation, known, {});
    }
    // Usually a key looked up in another region than its own, so the message names the region.
    if (error.name === "NotFoundException") {
      return this.#error(operation, ERRORS.notFound, { region: await this.#region() });
    }
    if (error.name === "AccessDeniedException") {
      return this.#error(operation, ERRORS.accessDenied, { region: await this.#region() });
    }
    return undefined;
  }

  /**
   * The region the client sends to, as the SDK resolved it: the key's or the key ARN's, or else
   * AWS_REGION or the profile's. A region is not secret, but only a value shaped like one is shown.
   */
  async #region(): Promise<string> {
    try {
      const region: unknown = await this.#client.config.region();
      return typeof region === "string" && REGION.test(region) ? region : "(unknown)";
    } catch {
      return "(unknown)";
    }
  }

  public async close(): Promise<void> {
    this.#client.destroy();
    await Promise.resolve();
  }

  #error<Template extends string>(
    operation: string,
    entry: ErrorEntry<Template, "error">,
    params: TemplateParams<Template>,
  ): Error {
    return catalogError(entry, params, { provider: "aws", operation, key: this.#key.displayId });
  }
}

/**
 * Builds the adapter for an AWS KMS key.
 *
 * @param key - The resolved key.
 * @param sdk - The @aws-sdk/client-kms module.
 * @param userAgent - The plugin's user-agent tag, such as `hardhat-kms/1.0.0`.
 * @returns The adapter.
 */
export async function createAwsKeyAdapter(
  key: AwsKmsKeyConfig,
  sdk: AwsKmsSdk,
  userAgent: string,
): Promise<KmsKeyAdapter> {
  const keyId = await key.keyId.get();
  const settings = await awsClientSettings(key, keyId);
  const client = new sdk.KMSClient({
    // Appended to the SDK's own user agent, so CloudTrail's `userAgent` shows which calls came
    // through the plugin. `userAgentAppId` stays free for the user's AWS_SDK_UA_APP_ID.
    customUserAgent: userAgent,
    ...settings,
    ...(key.endpoint === undefined ? {} : { endpoint: key.endpoint }),
  });
  return new AwsKeyAdapter(key, keyId, sdk, client);
}
