import { Contract, ContractSpec, xdr } from '..'
import { Server } from '../soroban';
import { AssembledTransaction } from './assembled_transaction'
import type { ContractClientOptions, MethodOptions } from './types'


export class ContractClient {
  /**
   * Generate a class from the contract spec that where each contract method
   * gets included with an identical name.
   *
   * Each method returns an {@link AssembledTransaction} that can be used to
   * modify, simulate, decode results, and possibly sign, & submit the
   * transaction.
   */
  constructor(
    public readonly spec: ContractSpec,
    public readonly options: ContractClientOptions,
  ) {
    let methods = this.spec.funcs();
    for (let method of methods) {
      let name = method.name().toString();
      // @ts-ignore
      this[name] = async (
        args: Record<string, any>,
        options: MethodOptions
      ) => {
        return await AssembledTransaction.build({
          method: name,
          args: spec.funcArgsToScVals(name, args),
          ...options,
          ...this.options,
          errorTypes: spec
            .errorCases()
            .reduce(
              (acc, curr) => ({
                ...acc,
                [curr.value()]: { message: curr.doc().toString() },
              }),
              {} as Pick<ContractClientOptions, "errorTypes">
            ),
          parseResultXdr: (result: xdr.ScVal) => spec.funcResToNative(name, result),
        });
      };
    }
  }

  static async from(options: ContractClientOptions): Promise<ContractClient> {
    if (!options || !options.rpcUrl || !options.contractId) {
      throw new TypeError('options must contain rpcUrl and contractId');
    }
    const { rpcUrl, contractId } = options;
    const server = new Server(rpcUrl);
    const contractLedgerKey = new Contract(contractId).getFootprint();
    // const contractIdBuffer = StrKey.decodeContract(contractId);
    // const ledgerKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({
    //     hash: contractFootprint,
    // }));
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
    const wasmModule = await WebAssembly.compile(wasmBuffer);
    const xdrSections = WebAssembly.Module.customSections(wasmModule, "contractspecv0");
    console.log(xdrSections);
    if (xdrSections.length === 0) {
      return Promise.reject({ code: 404, message: 'Could not obtain contract spec from wasm' });
    }
    const specArray = xdrSections.map((section, index) => {
      console.log(`Processing section ${index} with length ${section.byteLength}`);

      let bufferSection = Buffer.from(section);
      console.log(bufferSection)

      function printBuffer(buffer: Buffer): void {
        const length = buffer.length;
        console.log(`Length: ${length} (0x${length.toString(16)}) bytes`);

        for (let i = 0; i < length; i += 16) {
          let hexPart = '';
          let asciiPart = '';

          for (let j = 0; j < 16; j++) {
            if (i + j < length) {
              const byte = buffer[i + j];
              hexPart += ` ${byte.toString(16).padStart(2, '0')}`;
              asciiPart += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.';
            } else {
              hexPart += '   ';
            }
          }

          console.log(`${(i / 16).toString(16).padStart(4, '0')}:  ${hexPart}  ${asciiPart}`);
        }
      }
      printBuffer(bufferSection);

      let result;
      try {
        result = xdr.ScSpecEntry.fromXDR(bufferSection);
      } catch (error) {
        console.error(error);
        throw new Error(`Error processing section ${index}: ${error}`);
      }

      // Check for remaining data in the buffer
      if (bufferSection.length > 0) {
        console.warn(`Section ${index} was not entirely consumed`);
      }

      return result;
    }).filter(Boolean);
    /*const specArray = xdrSections.map(section =>
      xdr.ScSpecEntry.fromXDR(Buffer.from(section), "raw")
    ).filter(Boolean);*/
    if (!specArray) {
      return Promise.reject({ code: 404, message: 'Could not obtain contract spec from wasm' });
    }
    const spec = new ContractSpec(specArray);
    return new ContractClient(spec, options);
  }

  txFromJSON = <T>(json: string): AssembledTransaction<T> => {
    const { method, ...tx } = JSON.parse(json)
    return AssembledTransaction.fromJSON(
      {
        ...this.options,
        method,
        parseResultXdr: (result: xdr.ScVal) => this.spec.funcResToNative(method, result),
      },
      tx,
    );
  }
}
