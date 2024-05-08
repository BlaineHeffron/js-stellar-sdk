import { Contract, ContractSpec, xdr } from '..'
import { Server } from '../soroban';
import { AssembledTransaction } from './assembled_transaction'
import type { ContractClientOptions, MethodOptions } from './types'
import { processSpecEntryStream } from './utils';

/**
 * The ContractClient class is responsible for generating a class from a contract spec,
 * where each contract method is included with an identical name. Each method returns an
 * AssembledTransaction that can be used to modify, simulate, decode results, and possibly
 * sign and submit the transaction.
 *
 * The class also provides static methods for creating a ContractClient instance from a
 * WebAssembly module or from an RPC URL and contract ID.
 *
 * Additionally, it includes a `txFromJSON` method that creates an AssembledTransaction
 * from a JSON string representation.
 */
export class ContractClient {
  /**
   * Generate a class from the contract spec that where each contract method
   * gets included with an identical name.
   *
   */
  constructor(
    public readonly spec: ContractSpec,
    public readonly options: ContractClientOptions,
  ) {
    this.spec.funcs().forEach((xdrFn) => {
      const method = xdrFn.name().toString();
      const assembleTransaction = (
        args?: Record<string, any>,
        methodOptions?: MethodOptions,
      ) =>
        AssembledTransaction.build({
          method,
          args: args && spec.funcArgsToScVals(method, args),
          ...options,
          ...methodOptions,
          errorTypes: spec.errorCases().reduce(
            (acc, curr) => ({
              ...acc,
              [curr.value()]: { message: curr.doc().toString() },
            }),
            {} as Pick<ContractClientOptions, "errorTypes">,
          ),
          parseResultXdr: (result: xdr.ScVal) =>
            spec.funcResToNative(method, result),
        });

      // @ts-ignore error TS7053: Element implicitly has an 'any' type
      this[method] =
        spec.getFunc(method).inputs().length === 0
          ? (opts?: MethodOptions) => assembleTransaction(undefined, opts)
          : assembleTransaction;
    });
  }
  /**
   * Generate a ContractClient instance from the ContractClientOptions and the wasm binary
   */
  static async fromWasm(options: ContractClientOptions, wasm: BufferSource): Promise<ContractClient> {
    const wasmModule = await WebAssembly.compile(wasm);
    const xdrSections = WebAssembly.Module.customSections(wasmModule, "contractspecv0");
    if (xdrSections.length === 0) {
      return Promise.reject({ code: 404, message: 'Could not obtain contract spec from wasm' });
    }
    const section = xdrSections[0];
    const bufferSection = Buffer.from(section);
    const specEntryArray = processSpecEntryStream(bufferSection);
    const spec = new ContractSpec(specEntryArray);
    return new ContractClient(spec, options);
  }
  /**
   * Generate a ContractClient instance from the contractId and rpcUrl
   */
  static async from(options: ContractClientOptions): Promise<ContractClient> {
    if (!options || !options.rpcUrl || !options.contractId) {
      throw new TypeError('options must contain rpcUrl and contractId');
    }
    const { rpcUrl, contractId } = options;
    const server = new Server(rpcUrl);
    const contractLedgerKey = new Contract(contractId).getFootprint();
    const response = await server.getLedgerEntries(contractLedgerKey);
    if (!response.entries[0]?.val) {
      return Promise.reject({
        code: 404,
        message: `Could not obtain contract from server`,
      });
    }
    const wasmHash = ((response.entries[0].val.value() as xdr.ContractDataEntry).val().value() as xdr.ScContractInstance).executable().wasmHash();
    const ledgerKeyWasmHash = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({
      hash: wasmHash,
    }));
    const responseWasm = await server.getLedgerEntries(ledgerKeyWasmHash);
    const wasmBuffer = (responseWasm.entries[0].val.value() as xdr.ContractCodeEntry).code();
    return ContractClient.fromWasm(options, wasmBuffer);
  }
  /**
   * Take a json representation of the AssembledTransaction and return an {@link AssembledTransaction} that can be used to
   * modify, simulate, decode results, and possibly sign, & submit the
   * transaction.
   */
  txFromJSON = <T>(json: string): AssembledTransaction<T> => {
    const { method, ...tx } = JSON.parse(json);
    return AssembledTransaction.fromJSON(
      {
        ...this.options,
        method,
        parseResultXdr: (result: xdr.ScVal) =>
          this.spec.funcResToNative(method, result),
      },
      tx,
    );
  };
}

