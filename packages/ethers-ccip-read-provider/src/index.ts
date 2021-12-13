import { defaultAbiCoder } from '@ethersproject/abi';
import { arrayify, BytesLike, hexConcat, hexlify } from '@ethersproject/bytes';
import { Logger } from '@ethersproject/logger';
import { BaseProvider, Network } from '@ethersproject/providers';
import { fetchJson } from '@ethersproject/web';

const logger = new Logger('0.1.0');

const OFFCHAIN_LOOKUP_TYPE = ['address', 'string', 'bytes', 'bytes4', 'bytes'];
const CALLBACK_TYPE = ['bytes', 'bytes'];

export type Fetch = (connection: string, json?: string) => Promise<any>;

export class CCIPReadProvider extends BaseProvider {
    readonly parent: BaseProvider;
    readonly fetcher: Fetch;

    constructor(provider: BaseProvider, fetcher: Fetch = fetchJson) {
        super(provider.getNetwork());
        this.parent = provider;
        this.fetcher = fetcher;
    }

    perform(method: string, params: any): Promise<any> {
        switch(method) {
            case 'call':
                return this.handleCall(params);
            default:
                return this.parent.perform(method, params);
        }
    }

    detectNetwork(): Promise<Network> {
        return this.parent.detectNetwork();
    }

    private async handleCall(params: any): Promise<any> {
        const result = await this.parent.perform('call', params);
        const bytes = arrayify(result);
        
        if(bytes.length % 32 !== 4 || hexlify(bytes.slice(0, 4)) !== "0xd697c627") {
            return bytes;
        }

        const [sender, url, callData, callbackFunction, extraData] = defaultAbiCoder.decode(OFFCHAIN_LOOKUP_TYPE, bytes.slice(4));
        if(sender.toLowerCase() !== params.transaction.to.toLowerCase()) {
            return logger.throwError("OffchainLookup thrown in nested scope", Logger.errors.UNSUPPORTED_OPERATION, {
                to: params.transaction.to,
                sender,
                url,
                callData,
                callbackFunction,
                extraData
            });
        }
        const response = await this.sendRPC(url, params.transaction.to, callData);
        const data = hexConcat([callbackFunction, defaultAbiCoder.encode(CALLBACK_TYPE, [response, extraData])]);
        const request = Object.assign({}, params, {
            transaction: Object.assign({}, params.transaction, {data}),
        });
        return this.handleCall(request);
    }

    private async sendRPC(url: string, to: BytesLike, callData: BytesLike): Promise<BytesLike> {
        const data = await this.fetcher(url, JSON.stringify({
            id: "1",
            data: {
                to: hexlify(to),
                data: hexlify(callData),
            }
        }));
        if(data.statusCode < 200 || data.statusCode > 299) {
            return logger.throwError("bad response", Logger.errors.SERVER_ERROR, {
                status: data.statusCode,
                name: data.error.name,
                message: data.error.message,
            })
        }
        return data.data.result;
    }
}
