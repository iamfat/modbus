type Logger = {
    info(...args: any[]): void;
    debug(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
    fatal(...args: any[]): void;
};

const NullLogger = new Proxy({} as Logger, {
    get() {
        return () => {};
    },
});

type Options = {
    logger?: Logger;
    write?: (data: ArrayBuffer) => void;
};

type Frame = { crc: number; address: number; code: number; length: number; data: ArrayBuffer };

type Response = { address?: number; state?: boolean; value?: number; states?: boolean[] };

type Unit = {
    readCoilStatus(dataAddress: number, length: number): Promise<Response>;
    readInputStatus(dataAddress: number, length: number, code: number): Promise<Response>;
    readHoldingRegisters(dataAddress: number, length: number): Promise<Response>;
    readInputRegisters(dataAddress, length, code): Promise<Response>;
    writeCoil(dataAddress, state): Promise<Response>;
    writeRegister(dataAddress, value): Promise<Response>;
    writeCoils(dataAddress, array): Promise<Response>;
    writeRegisters(dataAddress, array): Promise<Response>;
};

const MODBUS_RESPONSE_TIMEOUT = 250;

const crc16 = function (buffer: ArrayBuffer) {
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
};

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
                    const buf = new ArrayBuffer(codeLength + 2); // add 2 crc bytes
                    const view = new DataView(buf);

                    view.setUint8(0, address);
                    view.setUint8(1, code);
                    view.setUint16(2, dataAddress, false);

                    view.setUint16(4, length, false);

                    // add crc bytes to buffer
                    view.setUint16(codeLength, crc16(buf.slice(0, -2)), true);

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
                readInputRegisters(dataAddress, length, code) {
                    // function code defaults to 4
                    code = code || 4;
                    const codeLength = 6;
                    const buf = new ArrayBuffer(codeLength + 2); // add 2 crc bytes
                    const view = new DataView(buf);

                    view.setUint8(0, address);
                    view.setUint8(1, code);
                    view.setUint16(2, dataAddress, false);

                    view.setUint16(4, length, false);

                    // add crc bytes to buffer
                    view.setUint16(codeLength, crc16(buf.slice(0, -2)), true);

                    return bus.writeBufferWithExpectation(buf, {
                        address,
                        code,
                        length: 3 + 2 * length + 2,
                    });
                },

                /**
                 * Write a Modbus "Force Single Coil" (FC=05) to serial port.
                 */
                writeCoil(dataAddress, state) {
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

                    return bus.writeBufferWithExpectation(buf, {
                        address,
                        code,
                        length: 8,
                    });
                },

                /**
                 * Write a Modbus "Preset Single Register " (FC=6) to serial port.
                 */
                writeRegister(dataAddress, value) {
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

                    return bus.writeBufferWithExpectation(buf, {
                        address,
                        code,
                        length: 8,
                    });
                },

                /**
                 * Write a Modbus "Force Multiple Coils" (FC=15) to serial port.
                 */
                writeCoils(dataAddress, array) {
                    const code = 15;
                    const i = 0;

                    const dataBytes = Math.ceil(array.length / 8);
                    const codeLength = 7 + dataBytes;
                    const buf = new ArrayBuffer(codeLength + 2); // add 2 crc bytes
                    const view = new DataView(buf);

                    view.setUint8(0, address);
                    view.setUint8(1, code);
                    view.setUint16(2, dataAddress, false);

                    view.setUint16(4, array.length, false);
                    view.setUint8(6, dataBytes);

                    // clear the data bytes before writing bits data
                    for (let i = 0; i < dataBytes; i++) {
                        view.setUint8(7 + i, 0);
                    }

                    for (let i = 0; i < array.length; i++) {
                        // buffer bits are already all zero (0)
                        // only set the ones set to one (1)
                        if (array[i]) {
                            view.setBit(7, i, true);
                        }
                    }

                    // add crc bytes to buffer
                    view.setUint16(codeLength, crc16(buf.slice(0, -2)), true);

                    return bus.writeBufferWithExpectation(buf, { address, code, length: 8 });
                },

                /**
                 * Write a Modbus "Preset Multiple Registers" (FC=16) to serial port.
                 */
                writeRegisters(dataAddress, array) {
                    const code = 16;
                    const codeLength = 7 + 2 * array.length;
                    const buf = new ArrayBuffer(codeLength + 2); // add 2 crc bytes
                    const view = new DataView(buf);

                    view.setUint8(0, address);
                    view.setUint8(1, code);
                    view.setUint16(2, dataAddress, false);

                    view.setUint16(4, array.length, false);
                    view.setUint8(6, array.length * 2);

                    for (let i = 0; i < array.length; i++) {
                        view.setUint16(7 + 2 * i, array[i], false);
                    }

                    // add crc bytes to buffer
                    view.setUint16(codeLength, crc16(buf.slice(0, -2)), true);

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

    private write(chunk: ArrayBuffer) {
        this.logger.debug('write', chunk);
    }

    private readingBuffer = new ArrayBuffer(0);
    public read(chunk: ArrayBuffer) {
        /* check minimal length */
        const bytes = new Uint8Array(this.readingBuffer.byteLength + chunk.byteLength);
        bytes.set(new Uint8Array(this.readingBuffer), 0);
        bytes.set(new Uint8Array(chunk), this.readingBuffer.byteLength);
        let buffer = bytes.buffer;
        for (;;) {
            if (buffer.byteLength < 5) {
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

        this.logger.debug('modbus.writeBuffer', buffer);
        this.write(buffer);
    }

    private parseFrame(buffer: ArrayBuffer): [Frame, ArrayBuffer] {
        const view = new DataView(buffer);
        const address = view.getUint8(0);
        const code = view.getUint8(1);
        const length = code >= 1 && code <= 4 ? view.getUint8(2) + 5 : 8;
        if (buffer.byteLength < length) {
            // 数据不足
            return [undefined, buffer];
        }

        return [
            {
                crc: view.getUint16(length - 2, true),
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
        buffer: ArrayBuffer;
        expectation: {
            address: number;
            code: number;
            length: number;
            resolve?: Function;
            reject?: Function;
            timeout?: NodeJS.Timeout | number;
        };
    }[] = [];
    private writeBufferWithExpectation(
        buffer: ArrayBuffer,
        expectation: { address: number; code: number; length: number },
    ) {
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
