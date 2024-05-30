import { toHex, nanoid } from './util';

type Logger = {
    debug(...args: any[]): void;
};

const NullLogger = new Proxy({} as Logger, {
    get() {
        return () => {};
    },
});

type Options = {
    logger?: Logger;
    timeout?: number | ((expection: Expectation) => number);
    write?: (data: ArrayBuffer) => void;
};

type Frame = { crc: number; address: number; code: number; length: number; data: ArrayBuffer };
type Response = { address?: number; state?: boolean; value?: number; states?: boolean[]; data?: number[] };
type Request = { address?: number; length?: number; data?: number[]; states?: boolean[] };

type Expectation = {
    address: number;
    code: number;
    length: number;
    resolve?: Function;
    reject?: Function;
    timeout?: string;
};

function crc16(buffer: ArrayBuffer) {
    let crc = 0xffff;
    let odd;

    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) {
        crc = crc ^ bytes[i];
        for (var j = 0; j < 8; j++) {
            odd = crc & 0x0001;
            crc = crc >> 1;
            if (odd) {
                crc = crc ^ 0xa001;
            }
        }
    }

    return crc;
}

const expectationTimeout: { [timeoutId: string]: { expires: number; callback: Function } } = {};
let expectationCleanUpIterval: any;

function addExpectationTimeout(callback: Function, timeout: number) {
    const timeoutId = nanoid(8);
    expectationTimeout[timeoutId] = {
        expires: Date.now() + timeout,
        callback,
    };
    if (!expectationCleanUpIterval) {
        expectationCleanUpIterval = setInterval(() => {
            const now = Date.now();
            Object.keys(expectationTimeout).forEach((timeoutId) => {
                const { expires, callback } = expectationTimeout[timeoutId];
                if (now >= expires) {
                    delete expectationTimeout[timeoutId];
                    callback();
                }
            });
        }, 250);
    }
    return timeoutId;
}

declare global {
    interface DataView {
        setBit(offset: number, bit: number, value: boolean): void;
    }
}

DataView.prototype.setBit = function (offset: number, bit: number, value: boolean) {
    let byteOffset = Math.floor(offset + bit / 8);
    let bitOffset = bit % 8;
    let bitMask = 0x1 << bitOffset;

    // get byte from buffer
    let byte = this.getUint8(byteOffset);

    // set bit on / off
    if (value) {
        byte |= bitMask;
    } else {
        byte &= ~bitMask;
    }

    // set byte to buffer
    this.setUint8(byteOffset, byte);
};

class TooShortError extends Error {
    constructor() {
        super();
        this.name = 'TooShortError';
    }
}

class FrameError extends Error {
    constructor() {
        super();
        this.name = 'FrameError';
    }
}

class CRCError extends Error {
    frame: Frame;
    constructor(frame: Frame) {
        super();
        this.name = 'CRCError';
        this.frame = frame;
    }
}

function ModBusUnit(bus: ModBus, address: number) {
    return {
        readCoilStatus(dataAddress: number, length: number) {
            return bus.readCoilStatus(address, dataAddress, length);
        },
        readInputStatus(dataAddress: number, length: number) {
            return bus.readInputStatus(address, dataAddress, length);
        },
        readHoldingRegisters(dataAddress: number, length: number) {
            return bus.readHoldingRegisters(address, dataAddress, length);
        },
        readInputRegisters(dataAddress: number, length: number) {
            return bus.readInputRegisters(address, dataAddress, length);
        },
        writeCoil(dataAddress: number, state: boolean) {
            return bus.writeCoil(address, dataAddress, state);
        },
        writeRegister(dataAddress: number, value: number) {
            return bus.writeRegister(address, dataAddress, value);
        },
        writeCoils(dataAddress: number, states: boolean[]) {
            return bus.writeCoils(address, dataAddress, states);
        },
        writeRegisters(dataAddress: number, values: number[]) {
            return bus.writeRegisters(address, dataAddress, values);
        },
    };
}

class ModBus {
    private logger: Logger;
    private timeout: (expection: Expectation) => number;
    private write: (chunk: ArrayBuffer) => void;

    constructor(options?: Options) {
        const { logger = NullLogger, timeout, write } = { ...options };
        this.logger = logger;
        if (typeof timeout === 'function') {
            this.timeout = timeout;
        } else if (typeof timeout === 'number') {
            this.timeout = () => Number(timeout);
        } else {
            this.timeout = (expectation) => Math.max(250, (expectation.length * 150000) / 9600);
        }
        this.write = write;
    }

    public tryParse(buffer: ArrayBuffer, incoming = true) {
        if (buffer.byteLength < 5) {
            // too short to be a frame, waiting for more data;
            throw new TooShortError();
        }

        const frame = incoming ? this.parseIncomingFrame(buffer) : this.parseOutgoingFrame(buffer);
        if (!frame) {
            throw new FrameError();
        }

        // check message CRC if CRC is bad raise an error
        const crc = crc16(frame.data);
        if (frame.crc !== crc) {
            this.logger.debug(`CRC error, expecting ${crc}, but got ${frame.crc}`, frame);
            throw new CRCError(frame);
        }

        let result = null;
        if (incoming) {
            // parse incoming data
            if (frame.code === 1 || frame.code === 2) {
                // Read Coil Status (FC=01)
                // Read Input Status (FC=02)
                result = this.parseCoils(frame);
            } else if (frame.code === 3 || frame.code === 4) {
                // Read Input Registers (FC=04)
                // Read Holding Registers (FC=03)
                result = this.parseInputRegisters(frame);
            } else if (frame.code === 5) {
                // Force Single Coil
                result = this.parseSingleCoil(frame);
            } else if (frame.code === 6) {
                // Preset Single Register
                result = this.parseSingleRegister(frame);
            } else if (frame.code === 15 || frame.code === 16) {
                // Force Multiple Coils
                // Preset Multiple Registers
                result = this.parseMultipleRegisters(frame);
            }
        } else {
            result = this.parseOutgoingResult(frame);
        }

        return { frame, result };
    }

    private readingBuffer = new ArrayBuffer(0);
    public read(chunk: ArrayBuffer) {
        /* check minimal length */
        const bytes = new Uint8Array(this.readingBuffer.byteLength + chunk.byteLength);
        bytes.set(new Uint8Array(this.readingBuffer), 0);
        bytes.set(new Uint8Array(chunk), this.readingBuffer.byteLength);
        let buffer = bytes.buffer;
        for (;;) {
            try {
                const { frame, result } = this.tryParse(buffer);
                if (this.isExpecting(frame)) {
                    this.resolveExpectation(result);
                } else {
                    this.rejectExpectation('UNEXPECTED_RESPONSE');
                }
                buffer = buffer.slice(frame.length);
            } catch (e) {
                // if (['TooShortError', 'FrameError'].includes(e.name)) {
                //     break;
                // }
                if (e.name === 'CRCError') {
                    buffer = buffer.slice(e.frame.length);
                    continue;
                }
                break;
            }
        }
        this.readingBuffer = buffer;
    }

    private parseIncomingFrame(buffer: ArrayBuffer): Frame | undefined {
        const view = new DataView(buffer);
        const address = view.getUint8(0);
        const code = view.getUint8(1);
        const length = code >= 1 && code <= 4 ? view.getUint8(2) + 5 : 8;
        if (buffer.byteLength < length) {
            // 数据不足
            return undefined;
        }

        return {
            crc: view.getUint16(length - 2, true),
            address,
            code,
            length,
            data: buffer.slice(0, length - 2),
        };
    }

    private parseOutgoingFrame(buffer: ArrayBuffer): Frame | undefined {
        const view = new DataView(buffer);
        const address = view.getUint8(0);
        const code = view.getUint8(1);
        if (buffer.byteLength < 8) {
            return;
        }

        let length = 0;
        if (code >= 1 && code <= 4) {
            // dataAddress: 2
            // length: 2
            length = 2 + 2 + 2 + 2;
        } else if (code === 5) {
            // dataAddress: 2
            // state: 2
            length = 2 + 2 + 2 + 2;
        } else if (code === 6) {
            // dataAddress: 2
            // data: 2
            length = 2 + 2 + 2 + 2;
        } else if (code === 15) {
            // dataAddress: 2
            // dataLength: 2
            // byteLength: 1
            // data: n
            const byteLength = view.getUint8(5);
            length = 2 + 2 + 2 + 2 + 2 + byteLength;
        } else if (code === 16) {
            // dataAddress: 2
            // dataLength: 2
            // byteLength: 1
            // data: n
            const byteLength = view.getUint8(5);
            length = 2 + 2 + 2 + 2 + 2 + byteLength;
        }

        if (buffer.byteLength < length) {
            return;
        }

        return {
            crc: view.getUint16(length - 2, true),
            address,
            code,
            length,
            data: buffer.slice(0, length - 2),
        };
    }

    private parseOutgoingResult(frame: Frame): Request {
        const view = new DataView(frame.data);
        if (frame.code >= 1 && frame.code <= 4) {
            // dataAddress: 2
            // length: 2
            return {
                address: view.getUint16(2, false),
                length: view.getUint16(4, false),
            };
        } else if (frame.code === 5) {
            // dataAddress: 2
            // state: 2
            return {
                address: view.getUint16(2, false),
                states: [view.getUint16(4, false) === 0xff00 ? true : false],
            };
        } else if (frame.code === 6) {
            // dataAddress: 2
            // data: 2
            return {
                address: view.getUint16(2, false),
                data: [view.getUint16(4, false)],
            };
        } else if (frame.code === 15) {
            // dataAddress: 2
            // dataLength: 2
            // byteLength: 1
            // data: n
            const states: boolean[] = [];
            const dataLength = view.getUint16(4, false);
            for (let i = 0; i < dataLength; i++) {
                let reg = view.getUint8(i + 6);
                for (let j = 0; j < 8; j++) {
                    states.push((reg & 1) === 1);
                    reg = reg >> 1;
                }
            }

            return {
                address: view.getUint16(2, false),
                states,
            };
        } else if (frame.code === 16) {
            // dataAddress: 2
            // dataLength: 2
            // byteLength: 1
            // data: n
            const data: number[] = [];
            const dataLength = view.getUint16(4, false);
            for (let i = 0; i < dataLength; i += 2) {
                let reg = view.getUint16(i + 3, false);
                data.push(reg);
            }
            return {
                address: view.getUint16(2, false),
                data,
            };
        }
        return null;
    }

    private resolveExpectation(result: Response) {
        const { timeout, resolve } = this.currentExpectation;
        this.currentExpectation = undefined;
        delete expectationTimeout[timeout];
        resolve(result);
    }

    private rejectExpectation(error: string) {
        const { address, reject, timeout } = this.currentExpectation;
        this.currentExpectation = undefined;
        delete expectationTimeout[timeout];
        this.logger.debug(`modbus.rejectExpectation address=${address} error=${error}`);
        reject(new Error(error));
    }

    private isExpecting(frame: Frame) {
        if (this.currentExpectation === undefined) {
            this.logger.debug(`ModBus.Unit(${frame.address}): No expectation`);
            return false;
        }

        const { address, code, length } = this.currentExpectation;
        if (frame.address !== address) {
            this.logger.debug(`modbus.isExpecting [address] expect=${address} actual=${frame.address}`);
            return false;
        }

        if (frame.length != length) {
            this.logger.debug(`modbus.isExpecting [length] expect=${length} actual=${frame.length}`);
            return false;
        }

        if (frame.code != code) {
            this.logger.debug(`modbus.isExpecting [code] expect=${code} actual=${frame.code}`);
            return false;
        }

        return true;
    }

    private queuePromise: Promise<Response> = Promise.resolve({});

    private currentExpectation?: Expectation;
    private writeBufferWithExpectation(buffer: ArrayBuffer, expectation: Expectation) {
        const prevPromise = this.queuePromise;
        this.queuePromise = new Promise<Response>((resolve, reject) => {
            prevPromise
                .catch(() => undefined)
                .finally(() => {
                    expectation.resolve = resolve;
                    expectation.reject = reject;
                    expectation.timeout = addExpectationTimeout(
                        () => this.rejectExpectation('EXPECT_TIMEOUT' + ' ' + toHex(buffer)),
                        this.timeout(expectation),
                    );
                    this.currentExpectation = expectation;
                    // 进行写操作的时候, 原有任何已读数据都应该清空
                    this.readingBuffer = new ArrayBuffer(0);
                    this.logger.debug('modbus.writeBuffer', toHex(buffer));
                    this.write?.(buffer);
                });
        });
        return this.queuePromise;
    }

    unit(address: number) {
        return ModBusUnit(this, address);
    }

    private readStatusBuffer(address: number, dataAddress: number, length: number, code: number) {
        const codeLength = 6;
        const buf = new ArrayBuffer(codeLength + 2); // add 2 crc bytes
        const view = new DataView(buf);

        view.setUint8(0, address);
        view.setUint8(1, code);
        view.setUint16(2, dataAddress, false);

        view.setUint16(4, length, false);

        // add crc bytes to buffer
        view.setUint16(codeLength, crc16(buf.slice(0, -2)), true);
        return buf;
    }
    private readStatus(address: number, dataAddress: number, length: number, code: number) {
        return this.writeBufferWithExpectation(this.readStatusBuffer(address, dataAddress, length, code), {
            address,
            code,
            length: 3 + Math.floor((length - 1) / 8 + 1) + 2,
        });
    }

    /**
     * Write a Modbus "Read Coil Status" (FC=01) to serial port.
     */
    readCoilStatus(address: number, dataAddress: number, length: number) {
        return this.readStatus(address, dataAddress, length, 1);
    }

    /**
     * Write a Modbus "Read Input Status" (FC=02) to serial port.
     */
    readInputStatus(address: number, dataAddress: number, length: number) {
        return this.readStatus(address, dataAddress, length, 2);
    }

    private readRegistersBuffer(address: number, dataAddress: number, length: number, code: number) {
        const codeLength = 6;
        const buf = new ArrayBuffer(codeLength + 2); // add 2 crc bytes
        const view = new DataView(buf);

        view.setUint8(0, address);
        view.setUint8(1, code);
        view.setUint16(2, dataAddress, false);

        view.setUint16(4, length, false);

        // add crc bytes to buffer
        view.setUint16(codeLength, crc16(buf.slice(0, -2)), true);
        return buf;
    }
    private readRegisters(address: number, dataAddress: number, length: number, code = 4) {
        return this.writeBufferWithExpectation(this.readRegistersBuffer(address, dataAddress, length, code), {
            address,
            code,
            length: 3 + 2 * length + 2,
        });
    }

    /**
     * Write a Modbus "Read Holding Registers" (FC=03) to serial port.
     */
    readHoldingRegisters(address: number, dataAddress: number, length: number) {
        return this.readRegisters(address, dataAddress, length, 3);
    }

    /**
     * Write a Modbus "Read Input Registers" (FC=04) to serial port.
     */
    readInputRegisters(address: number, dataAddress: number, length: number) {
        return this.readRegisters(address, dataAddress, length, 4);
    }

    /**
     * Write a Modbus "Force Single Coil" (FC=05) to serial port.
     */
    writeCoilBuffer(address: number, dataAddress: number, state: boolean) {
        const code = 5;
        const codeLength = 6;
        const buf = new ArrayBuffer(codeLength + 2); // add 2 crc bytes
        const view = new DataView(buf);

        view.setUint8(0, address);
        view.setUint8(1, code);
        view.setUint16(2, dataAddress, false);

        view.setUint16(4, state ? 0xff00 : 0x0000, false);

        // add crc bytes to buffer
        view.setUint16(codeLength, crc16(buf.slice(0, -2)), true);
        return buf;
    }

    writeCoil(address: number, dataAddress: number, state: boolean) {
        return this.writeBufferWithExpectation(this.writeCoilBuffer(address, dataAddress, state), {
            address,
            code: 5,
            length: 8,
        });
    }

    /**
     * Write a Modbus "Preset Single Register " (FC=6) to serial port.
     */
    writeRegisterBuffer(address: number, dataAddress: number, value: number) {
        const code = 6;
        const codeLength = 6; // 1B deviceAddress + 1B functionCode + 2B dataAddress + 2B value
        const buf = new ArrayBuffer(codeLength + 2); // add 2 crc bytes
        const view = new DataView(buf);

        view.setUint8(0, address);
        view.setUint8(1, code);
        view.setUint16(2, dataAddress, false);

        view.setUint16(4, value, false);

        // add crc bytes to buffer
        view.setUint16(codeLength, crc16(buf.slice(0, -2)), true);
        return buf;
    }
    writeRegister(address: number, dataAddress: number, value: number) {
        return this.writeBufferWithExpectation(this.writeRegisterBuffer(address, dataAddress, value), {
            address,
            code: 6,
            length: 8,
        });
    }

    /**
     * Write a Modbus "Force Multiple Coils" (FC=15) to serial port.
     */
    writeCoilsBuffer(address: number, dataAddress: number, states: boolean[]) {
        const code = 15;
        const i = 0;

        const dataBytes = Math.ceil(states.length / 8);
        const codeLength = 7 + dataBytes;
        const buf = new ArrayBuffer(codeLength + 2); // add 2 crc bytes
        const view = new DataView(buf);

        view.setUint8(0, address);
        view.setUint8(1, code);
        view.setUint16(2, dataAddress, false);

        view.setUint16(4, states.length, false);
        view.setUint8(6, dataBytes);

        // clear the data bytes before writing bits data
        for (let i = 0; i < dataBytes; i++) {
            view.setUint8(7 + i, 0);
        }

        for (let i = 0; i < states.length; i++) {
            // buffer bits are already all zero (0)
            // only set the ones set to one (1)
            if (states[i]) {
                view.setBit(7, i, true);
            }
        }

        // add crc bytes to buffer
        view.setUint16(codeLength, crc16(buf.slice(0, -2)), true);
        return buf;
    }
    writeCoils(address: number, dataAddress: number, states: boolean[]) {
        return this.writeBufferWithExpectation(this.writeCoilsBuffer(address, dataAddress, states), {
            address,
            code: 15,
            length: 8,
        });
    }

    /**
     * Write a Modbus "Preset Multiple Registers" (FC=16) to serial port.
     */
    writeRegistersBuffer(address: number, dataAddress: number, values: number[]) {
        const code = 16;
        const codeLength = 7 + 2 * values.length;
        const buf = new ArrayBuffer(codeLength + 2); // add 2 crc bytes
        const view = new DataView(buf);

        view.setUint8(0, address);
        view.setUint8(1, code);
        view.setUint16(2, dataAddress, false);

        view.setUint16(4, values.length, false);
        view.setUint8(6, values.length * 2);

        for (let i = 0; i < values.length; i++) {
            view.setUint16(7 + 2 * i, values[i], false);
        }

        // add crc bytes to buffer
        view.setUint16(codeLength, crc16(buf.slice(0, -2)), true);
        return buf;
    }
    writeRegisters(address: number, dataAddress: number, values: number[]) {
        return this.writeBufferWithExpectation(this.writeRegistersBuffer(address, dataAddress, values), {
            address,
            code: 16,
            length: 8,
        });
    }

    /**
     * Parse the data for a Modbus -
     * Read Coils (FC=02, 01)
     *
     * @param {Frame} frame the data buffer to parse.
     */
    private parseCoils(frame: Frame) {
        const view = new DataView(frame.data);
        const length = view.getUint8(2);
        const states: boolean[] = [];

        for (let i = 0; i < length; i++) {
            let reg = view.getUint8(i + 3);
            for (let j = 0; j < 8; j++) {
                states.push((reg & 1) === 1);
                reg = reg >> 1;
            }
        }

        return { states };
    }

    /**
     * Parse the data for a Modbus -
     * Read Input Registers (FC=04, 03)
     *
     * @param {Frame} frame the data buffer to parse.
     */
    private parseInputRegisters(frame: Frame) {
        const view = new DataView(frame.data);
        const length = view.getUint8(2);
        const contents = [];
        for (let i = 0; i < length; i += 2) {
            let reg = view.getUint16(i + 3, false);
            contents.push(reg);
        }
        return { data: contents };
    }

    /**
     * Parse the data for a Modbus -
     * Force Single Coil (FC=05)
     *
     * @param {Frame} frame the data buffer to parse.
     */
    private parseSingleCoil(frame: Frame) {
        const view = new DataView(frame.data);
        const address = view.getUint16(2, false);
        const state = view.getUint16(4, false) === 0xff00;
        return { address, state };
    }

    /**
     * Parse the data for a Modbus -
     * Preset Single Register (FC=06)
     *
     * @param {Frame} frame the data buffer to parse.
     */
    private parseSingleRegister(frame: Frame) {
        const view = new DataView(frame.data);
        const address = view.getUint16(2, false);
        const value = view.getUint16(4, false);
        return { address, value };
    }

    /**
     * Parse the data for a Modbus -
     * Preset Multiple Registers (FC=15, 16)
     *
     * @param {Frame} frame the data buffer to parse.
     */
    private parseMultipleRegisters(frame: Frame) {
        const view = new DataView(frame.data);
        const address = view.getUint16(2, false);
        const length = view.getUint16(4, false);
        return { address, length };
    }
}

export default ModBus;
