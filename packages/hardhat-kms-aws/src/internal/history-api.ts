import type {
  CloudTrailClient,
  CloudTrailClientConfig,
  LookupEventsCommand,
} from "@aws-sdk/client-cloudtrail";
import type { GetPublicKeyCommand, KMSClient, KMSClientConfig } from "@aws-sdk/client-kms";
import type { GetCallerIdentityCommand, STSClient, STSClientConfig } from "@aws-sdk/client-sts";
import { parseAwsKeyId } from "hardhat-kms/provider-utils";
import type { AwsKmsKeyConfig } from "hardhat-kms/types";

/** The parts of @aws-sdk/client-cloudtrail the history reader uses. */
interface CloudTrailSdk {
  CloudTrailClient: new (config: CloudTrailClientConfig) => CloudTrailClient;
  LookupEventsCommand: typeof LookupEventsCommand;
}

/** The parts of @aws-sdk/client-sts the history reader uses. */
interface StsSdk {
  STSClient: new (config: STSClientConfig) => STSClient;
  GetCallerIdentityCommand: typeof GetCallerIdentityCommand;
}

/** The parts of @aws-sdk/client-kms the history reader uses. */
interface KmsSdk {
  KMSClient: new (config: KMSClientConfig) => KMSClient;
  GetPublicKeyCommand: typeof GetPublicKeyCommand;
}

/**
 * Loads each SDK the reader needs. Only `kms history` calls them: CloudTrail always, STS for a key
 * named by an ARN, and KMS for an alias or a bare key id.
 */
export interface AwsHistorySdks {
  cloudTrail: () => Promise<CloudTrailSdk>;
  sts: () => Promise<StsSdk>;
  kms: () => Promise<KmsSdk>;
}

/** One page of `LookupEvents`: each event's `CloudTrailEvent` JSON, and the next page's token. */
export interface CloudTrailPage {
  events: ReadonlyArray<string | undefined>;
  nextToken: string | undefined;
}

/**
 * The AWS calls `kms history` makes, behind one interface so the reader's logic can be tested
 * with a plain fake. Errors from the SDK pass through unchanged; the reader sorts them.
 */
export interface AwsHistoryApi {
  /** The Region that CloudTrail reads go to. */
  region(): Promise<string>;
  /** One page of `Sign` events between `start` and `end`, newest first, at most 50. */
  lookupSignEvents(
    range: { start: Date; end: Date },
    nextToken: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CloudTrailPage>;
  /** The account of the credentials, from STS `GetCallerIdentity`. */
  callerAccount(signal: AbortSignal | undefined): Promise<string | undefined>;
  /** The key ARN of an alias or key id, from KMS `GetPublicKey`, which CloudTrail logs. */
  resolveKeyArn(keyId: string, signal: AbortSignal | undefined): Promise<string | undefined>;
  /** Destroys the clients it created. */
  close(): void;
}

/** `LookupEvents` returns at most 50 events per page. */
const PAGE_SIZE = 50;

/** The send options for a signal that may be absent. */
function sendOptions(signal: AbortSignal | undefined): { abortSignal?: AbortSignal } {
  return signal === undefined ? {} : { abortSignal: signal };
}

/**
 * Builds the AWS calls for one key's history. CloudTrail, STS and KMS clients use the key's
 * Region (a key ARN's own Region first) and profile, and tag their requests with the plugin's
 * user agent. Only the KMS client uses the key's `endpoint`, which points at a KMS service; the
 * SDK's own `AWS_ENDPOINT_URL_CLOUDTRAIL` and `AWS_ENDPOINT_URL_STS` settings still apply.
 *
 * @param key - The resolved key.
 * @param keyId - The key's identifier, read from the config.
 * @param sdks - Loaders for the SDKs.
 * @param userAgent - The plugin's user-agent tag, such as `hardhat-kms/1.0.0`.
 * @returns The calls.
 */
export async function createAwsHistoryApi(
  key: AwsKmsKeyConfig,
  keyId: string,
  sdks: AwsHistorySdks,
  userAgent: string,
): Promise<AwsHistoryApi> {
  const region = parseAwsKeyId(keyId)?.region ?? key.region;
  const shared = {
    customUserAgent: userAgent,
    ...(region === undefined ? {} : { region }),
    ...(key.profile === undefined ? {} : { profile: key.profile }),
  };
  const cloudTrailSdk = await sdks.cloudTrail();
  const cloudTrail = new cloudTrailSdk.CloudTrailClient(shared);
  const others: Array<{ destroy(): void }> = [];

  return {
    region: async () => await cloudTrail.config.region(),
    lookupSignEvents: async (range, nextToken, signal) => {
      const output = await cloudTrail.send(
        new cloudTrailSdk.LookupEventsCommand({
          LookupAttributes: [{ AttributeKey: "EventName", AttributeValue: "Sign" }],
          StartTime: range.start,
          EndTime: range.end,
          MaxResults: PAGE_SIZE,
          ...(nextToken === undefined ? {} : { NextToken: nextToken }),
        }),
        sendOptions(signal),
      );
      return {
        events: (output.Events ?? []).map((event) => event.CloudTrailEvent),
        nextToken: output.NextToken === "" ? undefined : output.NextToken,
      };
    },
    callerAccount: async (signal) => {
      const sts = await sdks.sts();
      const client = new sts.STSClient(shared);
      others.push(client);
      return (await client.send(new sts.GetCallerIdentityCommand({}), sendOptions(signal))).Account;
    },
    resolveKeyArn: async (id, signal) => {
      const kms = await sdks.kms();
      const client = new kms.KMSClient({
        ...shared,
        ...(key.endpoint === undefined ? {} : { endpoint: key.endpoint }),
      });
      others.push(client);
      return (await client.send(new kms.GetPublicKeyCommand({ KeyId: id }), sendOptions(signal)))
        .KeyId;
    },
    close: () => {
      cloudTrail.destroy();
      for (const client of others) {
        client.destroy();
      }
    },
  };
}
