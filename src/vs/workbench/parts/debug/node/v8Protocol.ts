/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as stream from 'stream';
import { Emitter, Event } from 'vs/base/common/event';
import { IDebugAdapterProtocol } from 'vs/workbench/parts/debug/common/debug';

export class DebugAdapterProtocol implements IDebugAdapterProtocol {

	private static readonly TWO_CRLF = '\r\n\r\n';

	private outputStream: stream.Writable;
	private sequence: number;
	private pendingRequests: Map<number, (e: DebugProtocol.Response) => void>;
	private rawData: Buffer;
	private contentLength: number;

	protected readonly _onError: Emitter<Error>;
	private readonly _onEvent: Emitter<DebugProtocol.Event>;
	private readonly _onRequest: Emitter<DebugProtocol.Request>;

	constructor() {
		this.sequence = 1;
		this.contentLength = -1;
		this.pendingRequests = new Map<number, (e: DebugProtocol.Response) => void>();
		this.rawData = Buffer.allocUnsafe(0);

		this._onError = new Emitter<Error>();
		this._onEvent = new Emitter<DebugProtocol.Event>();
		this._onRequest = new Emitter<DebugProtocol.Request>();
	}

	public get onError(): Event<Error> {
		return this._onError.event;
	}

	public get onEvent(): Event<DebugProtocol.Event> {
		return this._onEvent.event;
	}

	public get onRequest(): Event<DebugProtocol.Request> {
		return this._onRequest.event;
	}

	public connect(readable: stream.Readable, writable: stream.Writable): void {

		this.outputStream = writable;

		readable.on('data', (data: Buffer) => {
			this.rawData = Buffer.concat([this.rawData, data]);
			this.handleData();
		});
	}

	public sendResponse(response: DebugProtocol.Response): void {
		if (response.seq > 0) {
			console.error(`attempt to send more than one response for command ${response.command}`);
		} else {
			this.sendMessage('response', response);
		}
	}

	public sendRequest(command: string, args: any, clb: (result: DebugProtocol.Response) => void): void {

		const request: any = {
			command: command
		};
		if (args && Object.keys(args).length > 0) {
			request.arguments = args;
		}

		this.sendMessage('request', request);

		if (clb) {
			// store callback for this request
			this.pendingRequests.set(request.seq, clb);
		}
	}

	private sendMessage(typ: 'request' | 'response' | 'event', message: DebugProtocol.ProtocolMessage): void {

		message.type = typ;
		message.seq = this.sequence++;

		const json = JSON.stringify(message);
		const length = Buffer.byteLength(json, 'utf8');

		this.outputStream.write('Content-Length: ' + length.toString() + DebugAdapterProtocol.TWO_CRLF, 'utf8');
		this.outputStream.write(json, 'utf8');
	}

	private handleData(): void {
		while (true) {
			if (this.contentLength >= 0) {
				if (this.rawData.length >= this.contentLength) {
					const message = this.rawData.toString('utf8', 0, this.contentLength);
					this.rawData = this.rawData.slice(this.contentLength);
					this.contentLength = -1;
					if (message.length > 0) {
						this.dispatch(message);
					}
					continue;	// there may be more complete messages to process
				}
			} else {
				const s = this.rawData.toString('utf8', 0, this.rawData.length);
				const idx = s.indexOf(DebugAdapterProtocol.TWO_CRLF);
				if (idx !== -1) {
					const match = /Content-Length: (\d+)/.exec(s);
					if (match && match[1]) {
						this.contentLength = Number(match[1]);
						this.rawData = this.rawData.slice(idx + DebugAdapterProtocol.TWO_CRLF.length);
						continue;	// try to handle a complete message
					}
				}
			}
			break;
		}
	}

	private dispatch(body: string): void {
		try {
			const rawData = JSON.parse(body);
			switch (rawData.type) {
				case 'event':
					this._onEvent.fire(<DebugProtocol.Event>rawData);
					break;
				case 'response':
					const response = <DebugProtocol.Response>rawData;
					const clb = this.pendingRequests.get(response.request_seq);
					if (clb) {
						this.pendingRequests.delete(response.request_seq);
						clb(response);
					}
					break;
				case 'request':
					this._onRequest.fire(<DebugProtocol.Request>rawData);
					break;
			}
		} catch (e) {
			this._onError.fire(new Error(e.message || e));
		}
	}
}
