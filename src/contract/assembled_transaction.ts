/* disable max-classes rule, because extending error shouldn't count! */
/* eslint max-classes-per-file: 0 */
import {
  Account,
  BASE_FEE,
  Contract,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  xdr,
} from "@stellar/stellar-base";
import type {
  AssembledTransactionOptions,
  ClientOptions,
  MethodOptions,
  Tx,
  XDR_BASE64,
} from "./types";
import { Server } from "../rpc/server";
import { Api } from "../rpc/api";
import { assembleTransaction } from "../rpc/transaction";
import type { Client } from "./client";
import { Err } from "./rust_result";
import {
  DEFAULT_TIMEOUT,
  contractErrorPattern,
  implementsToString,
} from "./utils";
import { SentTransaction } from "./sent_transaction";

export const NULL_ACCOUNT =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * The main workhorse of {@link Client}. This class is used to wrap a
 * transaction-under-construction and provide high-level interfaces to the most
 * common workflows, while still providing access to low-level stellar-sdk
 * transaction manipulation.
 *
 * Most of the time, you will not construct an `AssembledTransaction` directly,
 * but instead receive one as the return value of a `Client` method. If
 * you're familiar with the libraries generated by soroban-cli's `contract
 * bindings typescript` command, these also wraps `Client` and return
 * `AssembledTransaction` instances.
 *
 * Let's look at examples of how to use `AssembledTransaction` for a variety of
 * use-cases:
 *
 * # 1. Simple read call
 *
 * Since these only require simulation, you can get the `result` of the call
 * right after constructing your `AssembledTransaction`:
 *
 * ```ts
 * const { result } = await AssembledTransaction.build({
 *   method: 'myReadMethod',
 *   args: spec.funcArgsToScVals('myReadMethod', {
 *     args: 'for',
 *     my: 'method',
 *     ...
 *   }),
 *   contractId: 'C123…',
 *   networkPassphrase: '…',
 *   rpcUrl: 'https://…',
 *   publicKey: undefined, // irrelevant, for simulation-only read calls
 *   parseResultXdr: (result: xdr.ScVal) =>
 *     spec.funcResToNative('myReadMethod', result),
 * })
 * ```
 *
 * While that looks pretty complicated, most of the time you will use this in
 * conjunction with {@link Client}, which simplifies it to:
 *
 * ```ts
 * const { result }  = await client.myReadMethod({
 *   args: 'for',
 *   my: 'method',
 *   ...
 * })
 * ```
 *
 * # 2. Simple write call
 *
 * For write calls that will be simulated and then sent to the network without
 * further manipulation, only one more step is needed:
 *
 * ```ts
 * const assembledTx = await client.myWriteMethod({
 *   args: 'for',
 *   my: 'method',
 *   ...
 * })
 * const sentTx = await assembledTx.signAndSend()
 * ```
 *
 * Here we're assuming that you're using a {@link Client}, rather than
 * constructing `AssembledTransaction`'s directly.
 *
 * Note that `sentTx`, the return value of `signAndSend`, is a
 * {@link SentTransaction}. `SentTransaction` is similar to
 * `AssembledTransaction`, but is missing many of the methods and fields that
 * are only relevant while assembling a transaction. It also has a few extra
 * methods and fields that are only relevant after the transaction has been
 * sent to the network.
 *
 * Like `AssembledTransaction`, `SentTransaction` also has a `result` getter,
 * which contains the parsed final return value of the contract call. Most of
 * the time, you may only be interested in this, so rather than getting the
 * whole `sentTx` you may just want to:
 *
 * ```ts
 * const tx = await client.myWriteMethod({ args: 'for', my: 'method', ... })
 * const { result } = await tx.signAndSend()
 * ```
 *
 * # 3. More fine-grained control over transaction construction
 *
 * If you need more control over the transaction before simulating it, you can
 * set various {@link MethodOptions} when constructing your
 * `AssembledTransaction`. With a {@link Client}, this is passed as a
 * second object after the arguments (or the only object, if the method takes
 * no arguments):
 *
 * ```ts
 * const tx = await client.myWriteMethod(
 *   {
 *     args: 'for',
 *     my: 'method',
 *     ...
 *   }, {
 *     fee: '10000', // default: {@link BASE_FEE}
 *     simulate: false,
 *     timeoutInSeconds: 20, // default: {@link DEFAULT_TIMEOUT}
 *   }
 * )
 * ```
 *
 * Since we've skipped simulation, we can now edit the `raw` transaction and
 * then manually call `simulate`:
 *
 * ```ts
 * tx.raw.addMemo(Memo.text('Nice memo, friend!'))
 * await tx.simulate()
 * ```
 *
 * If you need to inspect the simulation later, you can access it with
 * `tx.simulation`.
 *
 * # 4. Multi-auth workflows
 *
 * Soroban, and Stellar in general, allows multiple parties to sign a
 * transaction.
 *
 * Let's consider an Atomic Swap contract. Alice wants to give 10 of her Token
 * A tokens to Bob for 5 of his Token B tokens.
 *
 * ```ts
 * const ALICE = 'G123...'
 * const BOB = 'G456...'
 * const TOKEN_A = 'C123…'
 * const TOKEN_B = 'C456…'
 * const AMOUNT_A = 10n
 * const AMOUNT_B = 5n
 * ```
 *
 * Let's say Alice is also going to be the one signing the final transaction
 * envelope, meaning she is the invoker. So your app, from Alice's browser,
 * simulates the `swap` call:
 *
 * ```ts
 * const tx = await swapClient.swap({
 *   a: ALICE,
 *   b: BOB,
 *   token_a: TOKEN_A,
 *   token_b: TOKEN_B,
 *   amount_a: AMOUNT_A,
 *   amount_b: AMOUNT_B,
 * })
 * ```
 *
 * But your app can't `signAndSend` this right away, because Bob needs to sign
 * it first. You can check this:
 *
 * ```ts
 * const whoElseNeedsToSign = tx.needsNonInvokerSigningBy()
 * ```
 *
 * You can verify that `whoElseNeedsToSign` is an array of length `1`,
 * containing only Bob's public key.
 *
 * Then, still on Alice's machine, you can serialize the
 * transaction-under-assembly:
 *
 * ```ts
 * const json = tx.toJSON()
 * ```
 *
 * And now you need to send it to Bob's browser. How you do this depends on
 * your app. Maybe you send it to a server first, maybe you use WebSockets, or
 * maybe you have Alice text the JSON blob to Bob and have him paste it into
 * your app in his browser (note: this option might be error-prone 😄).
 *
 * Once you get the JSON blob into your app on Bob's machine, you can
 * deserialize it:
 *
 * ```ts
 * const tx = swapClient.txFromJSON(json)
 * ```
 *
 * Or, if you're using a client generated with `soroban contract bindings
 * typescript`, this deserialization will look like:
 *
 * ```ts
 * const tx = swapClient.fromJSON.swap(json)
 * ```
 *
 * Then you can have Bob sign it. What Bob will actually need to sign is some
 * _auth entries_ within the transaction, not the transaction itself or the
 * transaction envelope. Your app can verify that Bob has the correct wallet
 * selected, then:
 *
 * ```ts
 * await tx.signAuthEntries()
 * ```
 *
 * Under the hood, this uses `signAuthEntry`, which you either need to inject
 * during initial construction of the `Client`/`AssembledTransaction`,
 * or which you can pass directly to `signAuthEntries`.
 *
 * Now Bob can again serialize the transaction and send back to Alice, where
 * she can finally call `signAndSend()`.
 *
 * To see an even more complicated example, where Alice swaps with Bob but the
 * transaction is invoked by yet another party, check out
 * [test-swap.js](../../test/e2e/src/test-swap.js).
 */
export class AssembledTransaction<T> {
  /**
   * The TransactionBuilder as constructed in `{@link
   * AssembledTransaction}.build`. Feel free set `simulate: false` to modify
   * this object before calling `tx.simulate()` manually. Example:
   *
   * ```ts
   * const tx = await myContract.myMethod(
   *   { args: 'for', my: 'method', ... },
   *   { simulate: false }
   * );
   * tx.raw.addMemo(Memo.text('Nice memo, friend!'))
   * await tx.simulate();
   * ```
   */
  public raw?: TransactionBuilder;

  /**
   * The Transaction as it was built with `raw.build()` right before
   * simulation. Once this is set, modifying `raw` will have no effect unless
   * you call `tx.simulate()` again.
   */
  public built?: Tx;

  /**
   * The result of the transaction simulation. This is set after the first call
   * to `simulate`. It is difficult to serialize and deserialize, so it is not
   * included in the `toJSON` and `fromJSON` methods. See `simulationData`
   * cached, serializable access to the data needed by AssembledTransaction
   * logic.
   */
  public simulation?: Api.SimulateTransactionResponse;

  /**
   * Cached simulation result. This is set after the first call to
   * {@link AssembledTransaction#simulationData}, and is used to facilitate
   * serialization and deserialization of the AssembledTransaction.
   *
   * Most of the time, if you need this data, you can call
   * `tx.simulation.result`.
   *
   * If you need access to this data after a transaction has been serialized
   * and then deserialized, you can call `simulationData.result`.
   */
  private simulationResult?: Api.SimulateHostFunctionResult;

  /**
   * Cached simulation transaction data. This is set after the first call to
   * {@link AssembledTransaction#simulationData}, and is used to facilitate
   * serialization and deserialization of the AssembledTransaction.
   *
   * Most of the time, if you need this data, you can call
   * `simulation.transactionData`.
   *
   * If you need access to this data after a transaction has been serialized
   * and then deserialized, you can call `simulationData.transactionData`.
   */
  private simulationTransactionData?: xdr.SorobanTransactionData;

  /**
   * The Soroban server to use for all RPC calls. This is constructed from the
   * `rpcUrl` in the options.
   */
  private server: Server;

  /**
   * The signed transaction.
   */
  private signed?: Tx;

  /**
   * A list of the most important errors that various AssembledTransaction
   * methods can throw. Feel free to catch specific errors in your application
   * logic.
   */
  static Errors = {
    ExpiredState: class ExpiredStateError extends Error { },
    NeedsMoreSignatures: class NeedsMoreSignaturesError extends Error { },
    NoSignatureNeeded: class NoSignatureNeededError extends Error { },
    NoUnsignedNonInvokerAuthEntries: class NoUnsignedNonInvokerAuthEntriesError extends Error { },
    NoSigner: class NoSignerError extends Error { },
    NotYetSimulated: class NotYetSimulatedError extends Error { },
    FakeAccount: class FakeAccountError extends Error { },
  };

  /**
   * Serialize the AssembledTransaction to a JSON string. This is useful for
   * saving the transaction to a database or sending it over the wire for
   * multi-auth workflows. `fromJSON` can be used to deserialize the
   * transaction. This only works with transactions that have been simulated.
   */
  toJSON() {
    return JSON.stringify({
      method: this.options.method,
      tx: this.built?.toXDR(),
      simulationResult: {
        auth: this.simulationData.result.auth.map((a) => a.toXDR("base64")),
        retval: this.simulationData.result.retval.toXDR("base64"),
      },
      simulationTransactionData:
        this.simulationData.transactionData.toXDR("base64"),
    });
  }

  static fromJSON<T>(
    options: Omit<AssembledTransactionOptions<T>, "args">,
    {
      tx,
      simulationResult,
      simulationTransactionData,
    }: {
      tx: XDR_BASE64;
      simulationResult: {
        auth: XDR_BASE64[];
        retval: XDR_BASE64;
      };
      simulationTransactionData: XDR_BASE64;
    },
  ): AssembledTransaction<T> {
    const txn = new AssembledTransaction(options);
    txn.built = TransactionBuilder.fromXDR(tx, options.networkPassphrase) as Tx;
    txn.simulationResult = {
      auth: simulationResult.auth.map((a) =>
        xdr.SorobanAuthorizationEntry.fromXDR(a, "base64"),
      ),
      retval: xdr.ScVal.fromXDR(simulationResult.retval, "base64"),
    };
    txn.simulationTransactionData = xdr.SorobanTransactionData.fromXDR(
      simulationTransactionData,
      "base64",
    );
    return txn;
  }

  private constructor(public options: AssembledTransactionOptions<T>) {
    this.options.simulate = this.options.simulate ?? true;
    this.server = new Server(this.options.rpcUrl, {
      allowHttp: this.options.allowHttp ?? false,
    });
  }

  /**
   * Construct a new AssembledTransaction. This is the only way to create a new
   * AssembledTransaction; the main constructor is private.
   *
   * This is an asynchronous constructor for two reasons:
   *
   * 1. It needs to fetch the account from the network to get the current
   *   sequence number.
   * 2. It needs to simulate the transaction to get the expected fee.
   *
   * If you don't want to simulate the transaction, you can set `simulate` to
   * `false` in the options.
   *
   *     const tx = await AssembledTransaction.build({
   *       ...,
   *       simulate: false,
   *     })
   */
  static async build<T>(
    options: AssembledTransactionOptions<T>,
  ): Promise<AssembledTransaction<T>> {
    const tx = new AssembledTransaction(options);
    const contract = new Contract(options.contractId);

    const account = options.publicKey
      ? await tx.server.getAccount(options.publicKey)
      : new Account(NULL_ACCOUNT, "0");

    tx.raw = new TransactionBuilder(account, {
      fee: options.fee ?? BASE_FEE,
      networkPassphrase: options.networkPassphrase,
    })
      .addOperation(contract.call(options.method, ...(options.args ?? [])))
      .setTimeout(options.timeoutInSeconds ?? DEFAULT_TIMEOUT);

    if (options.simulate) await tx.simulate();

    return tx;
  }

  simulate = async (): Promise<this> => {
    if (!this.raw) {
      throw new Error(
        "Transaction has not yet been assembled; " +
        "call `AssembledTransaction.build` first.",
      );
    }

    this.built = this.raw.build();
    this.simulation = await this.server.simulateTransaction(this.built);

    if (Api.isSimulationSuccess(this.simulation)) {
      this.built = assembleTransaction(
        this.built,
        this.simulation,
      ).build();
    }

    return this;
  };

  get simulationData(): {
    result: Api.SimulateHostFunctionResult;
    transactionData: xdr.SorobanTransactionData;
  } {
    if (this.simulationResult && this.simulationTransactionData) {
      return {
        result: this.simulationResult,
        transactionData: this.simulationTransactionData,
      };
    }
    const simulation = this.simulation!;
    if (!simulation) {
      throw new AssembledTransaction.Errors.NotYetSimulated(
        "Transaction has not yet been simulated",
      );
    }
    if (Api.isSimulationError(simulation)) {
      throw new Error(`Transaction simulation failed: "${simulation.error}"`);
    }

    if (Api.isSimulationRestore(simulation)) {
      throw new AssembledTransaction.Errors.ExpiredState(
        `You need to restore some contract state before you can invoke this method. ${JSON.stringify(
          simulation,
          null,
          2,
        )}`,
      );
    }

    if (!simulation.result) {
      throw new Error(
        `Expected an invocation simulation, but got no 'result' field. Simulation: ${JSON.stringify(
          simulation,
          null,
          2,
        )}`,
      );
    }

    // add to object for serialization & deserialization
    this.simulationResult = simulation.result;
    this.simulationTransactionData = simulation.transactionData.build();

    return {
      result: this.simulationResult,
      transactionData: this.simulationTransactionData!,
    };
  }

  get result(): T {
    try {
      return this.options.parseResultXdr(this.simulationData.result.retval);
    } catch (e) {
      if (!implementsToString(e)) throw e;
      const err = this.parseError(e.toString());
      if (err) return err as T;
      throw e; // eslint-disable-line
    }
  }

  private parseError(errorMessage: string) {
    if (!this.options.errorTypes) return undefined;
    const match = errorMessage.match(contractErrorPattern);
    if (!match) return undefined;
    const i = parseInt(match[1], 10);
    const err = this.options.errorTypes[i];
    if (!err) return undefined;
    return new Err(err);
  }

  /**
   * Sign the transaction with the `wallet`, included previously. If you did
   * not previously include one, you need to include one now that at least
   * includes the `signTransaction` method. 
   */
  sign = async ({
    force = false,
    signTransaction = this.options.signTransaction,
  }: {
    /**
     * If `true`, sign and send the transaction even if it is a read call
     */
    force?: boolean;
    /**
     * You must provide this here if you did not provide one before
     */
    signTransaction?: ClientOptions["signTransaction"];
  } = {}): Promise<void> => {
    if (!this.built) {
      throw new Error("Transaction has not yet been simulated");
    }

    if (!force && this.isReadCall) {
      throw new AssembledTransaction.Errors.NoSignatureNeeded(
        "This is a read call. It requires no signature or sending. " +
        "Use `force: true` to sign and send anyway.",
      );
    }

    if (!signTransaction) {
      throw new AssembledTransaction.Errors.NoSigner(
        "You must provide a signTransaction function, either when calling " +
        "`signAndSend` or when initializing your Client",
      );
    }

    if (this.needsNonInvokerSigningBy().length) {
      throw new AssembledTransaction.Errors.NeedsMoreSignatures(
        "Transaction requires more signatures. " +
        "See `needsNonInvokerSigningBy` for details.",
      );
    }

    const timeoutInSeconds =
      this.options.timeoutInSeconds ?? DEFAULT_TIMEOUT;
    this.built = TransactionBuilder.cloneFrom(this.built!, {
      fee: this.built!.fee,
      timebounds: undefined,
      sorobanData: this.simulationData.transactionData,
    })
      .setTimeout(timeoutInSeconds)
      .build();

    const signature = await signTransaction(
      this.built.toXDR(),
      {
        networkPassphrase: this.options.networkPassphrase,
      },
    );

    this.signed = TransactionBuilder.fromXDR(
      signature,
      this.options.networkPassphrase,
    ) as Tx;
  };

  /**
   * Sends the transaction to the network to return a `SentTransaction` that
   * keeps track of all the attempts to fetch the transaction.
   */
  async send(){
    if(!this.signed){
      throw new Error("The transaction has not yet been signed. Run `sign` first, or use `signAndSend` instead.");
    }
    const sent = await SentTransaction.init(this.options, this.signed);
    return sent;
  }

  /**
   * Sign the transaction with the `wallet`, included previously. If you did
   * not previously include one, you need to include one now that at least
   * includes the `signTransaction` method. After signing, this method will
   * send the transaction to the network and return a `SentTransaction` that
   * keeps track of all the attempts to fetch the transaction.
   */
  signAndSend = async ({
    force = false,
    signTransaction = this.options.signTransaction,
  }: {
    /**
     * If `true`, sign and send the transaction even if it is a read call
     */
    force?: boolean;
    /**
     * You must provide this here if you did not provide one before
     */
    signTransaction?: ClientOptions["signTransaction"];
  } = {}): Promise<SentTransaction<T>> => {
    if(!this.signed){
      await this.sign({ force, signTransaction });
    }
    return this.send();
  };

  private getStorageExpiration = async () => {
    const entryRes = await this.server.getLedgerEntries(
      new Contract(this.options.contractId).getFootprint(),
    );
    if (
      !entryRes.entries ||
      !entryRes.entries.length ||
      !entryRes.entries[0].liveUntilLedgerSeq
    )
      throw new Error("failed to get ledger entry");
    return entryRes.entries[0].liveUntilLedgerSeq;
  };

  /**
   * Get a list of accounts, other than the invoker of the simulation, that
   * need to sign auth entries in this transaction.
   *
   * Soroban allows multiple people to sign a transaction. Someone needs to
   * sign the final transaction envelope; this person/account is called the
   * _invoker_, or _source_. Other accounts might need to sign individual auth
   * entries in the transaction, if they're not also the invoker.
   *
   * This function returns a list of accounts that need to sign auth entries,
   * assuming that the same invoker/source account will sign the final
   * transaction envelope as signed the initial simulation.
   *
   * One at a time, for each public key in this array, you will need to
   * serialize this transaction with `toJSON`, send to the owner of that key,
   * deserialize the transaction with `txFromJson`, and call
   * {@link AssembledTransaction#signAuthEntries}. Then re-serialize and send to
   * the next account in this list.
   */
  needsNonInvokerSigningBy = ({
    includeAlreadySigned = false,
  }: {
    /**
     * Whether or not to include auth entries that have already been signed.
     * Default: false
     */
    includeAlreadySigned?: boolean;
  } = {}): string[] => {
    if (!this.built) {
      throw new Error("Transaction has not yet been simulated");
    }

    // We expect that any transaction constructed by these libraries has a
    // single operation, which is an InvokeHostFunction operation. The host
    // function being invoked is the contract method call.
    if (!("operations" in this.built)) {
      throw new Error(
        `Unexpected Transaction type; no operations: ${JSON.stringify(
          this.built,
        )}`,
      );
    }
    const rawInvokeHostFunctionOp = this.built
      .operations[0] as Operation.InvokeHostFunction;

    return [
      ...new Set(
        (rawInvokeHostFunctionOp.auth ?? [])
          .filter(
            (entry) =>
              entry.credentials().switch() ===
              xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
              (includeAlreadySigned ||
                entry.credentials().address().signature().switch().name ===
                "scvVoid"),
          )
          .map((entry) =>
            StrKey.encodeEd25519PublicKey(
              entry.credentials().address().address().accountId().ed25519(),
            ),
          ),
      ),
    ];
  };

  /**
   * If {@link AssembledTransaction#needsNonInvokerSigningBy} returns a
   * non-empty list, you can serialize the transaction with `toJSON`, send it to
   * the owner of one of the public keys in the map, deserialize with
   * `txFromJSON`, and call this method on their machine. Internally, this will
   * use `signAuthEntry` function from connected `wallet` for each.
   *
   * Then, re-serialize the transaction and either send to the next
   * `needsNonInvokerSigningBy` owner, or send it back to the original account
   * who simulated the transaction so they can {@link AssembledTransaction#sign}
   * the transaction envelope and {@link AssembledTransaction#send} it to the
   * network.
   *
   * Sending to all `needsNonInvokerSigningBy` owners in parallel is not
   * currently supported!
   */
  signAuthEntries = async ({
    expiration = this.getStorageExpiration(),
    signAuthEntry = this.options.signAuthEntry,
    publicKey = this.options.publicKey,
  }: {
    /**
     * When to set each auth entry to expire. Could be any number of blocks in
     * the future. Can be supplied as a promise or a raw number. Default:
     * contract's current `persistent` storage expiration date/ledger
     * number/block.
     */
    expiration?: number | Promise<number>;
    /**
     * Sign all auth entries for this account. Default: the account that
     * constructed the transaction
     */
    publicKey?: string;
    /**
     * You must provide this here if you did not provide one before. Default:
     * the `signAuthEntry` function from the `Client` options. Must
     * sign things as the given `publicKey`.
     */
    signAuthEntry?: ClientOptions["signAuthEntry"];
  } = {}): Promise<void> => {
    if (!this.built)
      throw new Error("Transaction has not yet been assembled or simulated");
    const needsNonInvokerSigningBy = this.needsNonInvokerSigningBy();

    if (!needsNonInvokerSigningBy) {
      throw new AssembledTransaction.Errors.NoUnsignedNonInvokerAuthEntries(
        "No unsigned non-invoker auth entries; maybe you already signed?",
      );
    }
    if (needsNonInvokerSigningBy.indexOf(publicKey ?? "") === -1) {
      throw new AssembledTransaction.Errors.NoSignatureNeeded(
        `No auth entries for public key "${publicKey}"`,
      );
    }
    if (!signAuthEntry) {
      throw new AssembledTransaction.Errors.NoSigner(
        "You must provide `signAuthEntry` when calling `signAuthEntries`, " +
        "or when constructing the `Client` or `AssembledTransaction`",
      );
    }

    const rawInvokeHostFunctionOp = this.built
      .operations[0] as Operation.InvokeHostFunction;

    const authEntries = rawInvokeHostFunctionOp.auth ?? [];

    // eslint-disable-next-line no-restricted-syntax
    for (const [i, entry] of authEntries.entries()) {
      if (
        entry.credentials().switch() !==
        xdr.SorobanCredentialsType.sorobanCredentialsAddress()
      ) {
        // if the invoker/source account, then the entry doesn't need explicit
        // signature, since the tx envelope is already signed by the source
        // account, so only check for sorobanCredentialsAddress
        continue; // eslint-disable-line no-continue
      }
      const pk = StrKey.encodeEd25519PublicKey(
        entry.credentials().address().address().accountId().ed25519(),
      );

      // this auth entry needs to be signed by a different account
      // (or maybe already was!)
      if (pk !== publicKey) continue; // eslint-disable-line no-continue

      // eslint-disable-next-line no-await-in-loop
      authEntries[i] = await authorizeEntry(
        entry,
        async (preimage) =>
          Buffer.from(await signAuthEntry(preimage.toXDR("base64")), "base64"),
        await expiration, // eslint-disable-line no-await-in-loop
        this.options.networkPassphrase,
      );
    }
  };

  /**
   * Whether this transaction is a read call. This is determined by the
   * simulation result and the transaction data. If the transaction is a read
   * call, it will not need to be signed and sent to the network. If this
   * returns `false`, then you need to call `signAndSend` on this transaction.
   */
  get isReadCall(): boolean {
    const authsCount = this.simulationData.result.auth.length;
    const writeLength = this.simulationData.transactionData
      .resources()
      .footprint()
      .readWrite().length;
    return authsCount === 0 && writeLength === 0;
  }
}
