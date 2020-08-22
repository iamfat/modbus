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
    write?: (data: Buffer) => void;
};

type Frame = { crc: number; address: number; code: number; length: number; data: Buffer };

type Response = { address?: number; state?: boolean; value?: number; states?: boolean[] };

type Unit = {
    readCoilStatus(dataAddress: number, length: number): Promise<Response>;
    readInputStatus(dataAddress: number, length: number, code: number): Promise<Response>;
    readHoldingRegisters(dataAddress: number, length: number): Promise<Response>;
    readInputRegisters(dataAddress: number, length: number, code: number): Promise<Response>;
    writeCoil(dataAddress: number, state: boolean): Promise<Response>;
    writeRegister(dataAddress: number, value: number): Promise<Response>;
    writeCoils(dataAddress: number, states: boolean[]): Promise<Response>;
    writeRegisters(dataAddress: number, values: number[]): Promise<Response>;
};

const MODBUS_RESPONSE_TIMEOUT = 250;

const crc16 = function (buffer: Buffer) {
    let crc = 0xffff;
    let odd;

    for (let i = 0; i < buffer.length; i++) {
        crc = crc ^ buffer[i];
        for (let j = 0; j < 8; j++) {
            odd = crc & 0x0001;
            crc = crc >> 1;
            if (odd) {
                crc = crc ^ 0xa001;
            }
        }
    }

    return crc;
};

declare global {
    interface Buffer {
        writeBit(value: boolean, bit: number, offset: number);
    }
}

Buffer.prototype.writeBit = function (value: boolean, bit: number, offset = 0) {
    let byteOffset = Math.floor(offset + bit / 8);
    let bitOffset = bit % 8;
    let bitMask = 0x1 << bitOffset;

    // get byte from buffer
    let byte = this.readUInt8(byteOffset);

    // set bit on / off
    if (value) {
        byte |= bitMask;
    } else {
        byte &= ~bitMask;
    }

    // set byte to buffer
    this.writeUInt8(byte, byteOffset);
};

class ModBus {
    private units: { [address: number]: Unit } = {};
    private logger: Logger;

    constructor(options: Options) {
        this.logger = options.logger || NullLogger;
        if (options.write) {
            this.write = options.write;
        }
    }

    unit(address: number) {
        const bus = this;
        if (!this.units.hasOwnProperty(address)) {
            this.units[address] = {
                /**
                 * Write a Modbus "Read Coil Status" (FC=01) to serial port.
                 */
                readCoilStatus(dataAddress: number, length: number) {
                    return this.readInputStatus(dataAddress, length, 1);
                },

                /**
                 * Write a Modbus "Read Input Status" (FC=02) to serial port.
                 */
                readInputStatus(dataAddress: number, length: number, code: number) {
                    // function code defaults to 2
                    code = code || 2;

                    const codeLength = 6;
                    const buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes

                    buf.writeUInt8(address, 0);
                    buf.writeUInt8(code, 1);
                    buf.writeUInt16BE(dataAddress, 2);
                    buf.writeUInt16BE(length, 4);

                    // add crc bytes to buffer
                    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);

                    return bus.writeBufferWithExpectation(buf, {
                        address,
                        code,
                        length: 3 + Math.floor((length - 1) / 8 + 1) + 2,
                    });
                },

                /**
                 * Write a Modbus "Read Holding Registers" (FC=03) to serial port.
                 */
                readHoldingRegisters(dataAddress: number, length: number) {
                    return this.readInputRegisters(dataAddress, length, 3);
                },

                /**
                 * Write a Modbus "Read Input Registers" (FC=04) to serial port.
                 */
                readInputRegisters(dataAddress: number, length: number, code: number) {
                    // function code defaults to 4
                    code = code || 4;
                    const codeLength = 6;
                    const buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes

                    buf.writeUInt8(address, 0);
                    buf.writeUInt8(code, 1);
                    buf.writeUInt16BE(dataAddress, 2);
                    buf.writeUInt16BE(length, 4);

                    // add crc bytes to buffer
                    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);

                    return bus.writeBufferWithExpectation(buf, {
                        address,
                        code,
                        length: 3 + 2 * length + 2,
                    });
                },

                /**
                 * Write a Modbus "Force Single Coil" (FC=05) to serial port.
                 */
                writeCoil(dataAddress: number, state: boolean) {
                    const code = 5;
                    const codeLength = 6;
                    const buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes

                    buf.writeUInt8(address, 0);
                    buf.writeUInt8(code, 1);
                    buf.writeUInt16BE(dataAddress, 2);

                    buf.writeUInt16BE(state ? 0xff00 : 0x0000, 4);

                    // add crc bytes to buffer
                    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);

                    return bus.writeBufferWithExpectation(buf, {
                        address,
                        code,
                        length: 8,
                    });
                },

                /**
                 * Write a Modbus "Preset Single Register " (FC=6) to serial port.
                 */
                writeRegister(dataAddress: number, value: number) {
                    const code = 6;
                    const codeLength = 6; // 1B deviceAddress + 1B functionCode + 2B dataAddress + 2B value
                    const buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes

                    buf.writeUInt8(address, 0);
                    buf.writeUInt8(code, 1);
                    buf.writeUInt16BE(dataAddress, 2);

                    buf.writeUInt16BE(value, 4);

                    // add crc bytes to buffer
                    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);

                    return bus.writeBufferWithExpectation(buf, {
                        address,
                        code,
                        length: 8,
                    });
                },

                /**
                 * Write a Modbus "Force Multiple Coils" (FC=15) to serial port.
                 */
                writeCoils(dataAddress: number, states: boolean[]) {
                    const code = 15;
                    const i = 0;

                    const dataBytes = Math.ceil(states.length / 8);
                    const codeLength = 7 + dataBytes;
                    const buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes

                    buf.writeUInt8(address, 0);
                    buf.writeUInt8(code, 1);
                    buf.writeUInt16BE(dataAddress, 2);
                    buf.writeUInt16BE(states.length, 4);
                    buf.writeUInt8(dataBytes, 6);

                    // clear the data bytes before writing bits data
                    for (let i = 0; i < dataBytes; i++) {
                        buf.writeUInt8(0, 7 + i);
                    }

                    for (let i = 0; i < states.length; i++) {
                        // buffer bits are already all zero (0)
                        // only set the ones set to one (1)
                        if (states[i]) {
                            buf.writeBit(true, i, 7);
                        }
                    }

                    // add crc bytes to buffer
                    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);

                    return bus.writeBufferWithExpectation(buf, { address, code, length: 8 });
                },

                /**
                 * Write a Modbus "Preset Multiple Registers" (FC=16) to serial port.
                 */
                writeRegisters(dataAddress: number, values: number[]) {
                    let code = 16;
                    let codeLength = 7 + 2 * values.length;
                    let buf = Buffer.alloc(codeLength + 2); // add 2 crc bytes

                    buf.writeUInt8(address, 0);
                    buf.writeUInt8(code, 1);
                    buf.writeUInt16BE(dataAddress, 2);
                    buf.writeUInt16BE(values.length, 4);
                    buf.writeUInt8(values.length * 2, 6);

                    for (let i = 0; i < values.length; i++) {
                        buf.writeUInt16BE(values[i], 7 + 2 * i);
                    }

                    // add crc bytes to buffer
                    buf.writeUInt16LE(crc16(buf.slice(0, -2)), codeLength);

                    return bus.writeBufferWithExpectation(buf, {
                        address,
                        code,
                        length: 8,
                    });
                },
            };
        }

        return this.units[address];
    }

    private write(chunk: Buffer) {
        this.logger.debug('write', chunk.toString('hex'));
    }

    private readingBuffer = Buffer.alloc(0);
    public read(chunk: Buffer) {
        /* check minimal length */
        let buffer = Buffer.concat([this.readingBuffer, chunk]);
        for (;;) {
            if (buffer.length < 5) {
                // too short to be a frame, waiting for more data;
                break;
            }

            let frame: Frame;
            [frame, buffer] = this.parseFrame(buffer);
            if (!frame) {
                break;
            }

            // check message CRC if CRC is bad raise an error
            const crc = crc16(frame.data);
            if (frame.crc !== crc) {
                this.logger.debug(`CRC error, expecting ${crc}, but got ${frame.crc}`, frame);
                if (this.currentExpectation) {
                    const { timeout, reject } = this.currentExpectation;
                    clearTimeout(timeout);
                    reject('CRC error');
                    this.currentExpectation = undefined;
                }
                continue;
            }

            if (this.isExpecting(frame)) {
                let ret = null;
                // parse incoming data
                if (frame.code === 1 || frame.code === 2) {
                    // Read Coil Status (FC=01)
                    // Read Input Status (FC=02)
                    ret = this.parseCoils(frame);
                } else if (frame.code === 3 || frame.code === 4) {
                    // Read Input Registers (FC=04)
                    // Read Holding Registers (FC=03)
                    ret = this.parseInputRegisters(frame);
                } else if (frame.code === 5) {
                    // Force Single Coil
                    ret = this.parseSingleCoil(frame);
                } else if (frame.code === 6) {
                    // Preset Single Register
                    ret = this.parseSingleRegister(frame);
                } else if (frame.code === 15 || frame.code === 16) {
                    // Force Multiple Coils
                    // Preset Multiple Registers
                    ret = this.parseMultipleRegisters(frame);
                }

                const { timeout, resolve } = this.currentExpectation;
                clearTimeout(timeout);
                resolve(ret);
                this.currentExpectation = undefined;
            } else if (this.currentExpectation) {
                const { timeout, reject } = this.currentExpectation;
                clearTimeout(timeout);
                reject('Unexpected response');
                this.currentExpectation = undefined;
            }
        }
        this.readingBuffer = buffer;
    }

    private currentExpectation;
    writeNext() {
        if (this.currentExpectation) {
            // someone is waiting, just return
            return;
        }
        const { buffer, expectation } = this.writingQueue.shift();
        this.currentExpectation = expectation;
        expectation.timeout = setTimeout(() => {
            const { address, code, length, reject } = expectation;
            const message = `ModBus: Expectation Timeout on Unit:${address}`;
            this.logger.debug(message, { address, code, length });
            reject(message);
            this.currentExpectation = undefined;
        }, MODBUS_RESPONSE_TIMEOUT);

        this.logger.debug('modbus.writeBuffer', buffer.toString('hex'));
        this.write(buffer);
    }

    private parseFrame(buffer: Buffer): [Frame, Buffer] {
        const address = buffer.readUInt8(0);
        const code = buffer.readUInt8(1);
        const length = code >= 1 && code <= 4 ? buffer.readUInt8(2) + 5 : 8;
        if (buffer.length < length) {
            // 数据不足
            return [undefined, buffer];
        }

        return [
            {
                crc: buffer.readUInt16LE(length - 2),
                address,
                code,
                length,
                data: buffer.slice(0, length - 2),
            },
            buffer.slice(length),
        ];
    }

    private isExpecting(frame: Frame) {
        if (this.currentExpectation === undefined) {
            this.logger.debug(`ModBus.Unit(${frame.address}): No expectation`);
            return false;
        }

        const { address, code, length } = this.currentExpectation;
        if (frame.address !== address) {
            this.logger.debug(
                `ModBus.Unit(${frame.address}): Address error, expected ${address} but got ${frame.address}`,
            );
            return false;
        }

        if (frame.length != length) {
            this.logger.debug(
                `ModBus.Unit(${frame.address}): Data length error, expected ${length} but got ${frame.length}`,
            );
            return false;
        }

        if (frame.code != code) {
            this.logger.debug(
                `ModBus.Unit(${frame.address}): Unexpected data error, expected ${code} but got ${frame.code}`,
            );
            return false;
        }

        return true;
    }

    private writingQueue: {
        buffer: Buffer;
        expectation: {
            address: number;
            code: number;
            length: number;
            resolve?: Function;
            reject?: Function;
            timeout?: NodeJS.Timeout | number;
        };
    }[] = [];
    private writeBufferWithExpectation(buffer: Buffer, expectation: { address: number; code: number; length: number }) {
        if (this.writingQueue.length > 10) {
            return new Promise((_, reject) => {
                reject('ModBus: expectation queue is full!');
            });
        }

        return new Promise((resolve, reject) => {
            this.writingQueue.push({
                buffer,
                expectation: { ...expectation, resolve, reject },
            });
            this.writeNext();
        });
    }

    /**
     * Parse the data for a Modbus -
     * Read Coils (FC=02, 01)
     *
     * @param {Frame} frame the data buffer to parse.
     */
    private parseCoils(frame: Frame) {
        const length = frame.data.readUInt8(2);
        const states: boolean[] = [];

        for (let i = 0; i < length; i++) {
            let reg = frame.data[i + 3];
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
        const length = frame.data.readUInt8(2);
        const contents = [];
        for (let i = 0; i < length; i += 2) {
            let reg = frame.data.readUInt16BE(i + 3);
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
        const address = frame.data.readUInt16BE(2);
        const state = frame.data.readUInt16BE(4) === 0xff00;
        return { address, state };
    }

    /**
     * Parse the data for a Modbus -
     * Preset Single Register (FC=06)
     *
     * @param {Frame} frame the data buffer to parse.
     */
    private parseSingleRegister(frame: Frame) {
        const address = frame.data.readUInt16BE(2);
        const value = frame.data.readUInt16BE(4);
        return { address, value };
    }

    /**
     * Parse the data for a Modbus -
     * Preset Multiple Registers (FC=15, 16)
     *
     * @param {Frame} frame the data buffer to parse.
     */
    private parseMultipleRegisters(frame: Frame) {
        const address = frame.data.readUInt16BE(2);
        const length = frame.data.readUInt16BE(4);
        return { address, length };
    }
}

export default ModBus;
