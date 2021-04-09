describe('ModBus', () => {
    const ModBus = require('../lib/index');
    const { toHex } = require('./helpers/util');

    it('should readCoilStatus()', async () => {
        const modbus = new ModBus({
            write(buffer) {
                // => 0x01 0x01 0x00 0x00 0x00 0x10 0x3D 0xC6
                // <= 0x01 0x01 0x02 0x03 0x00 0xB9 0x0C
                expect(toHex(buffer)).toBe('0101000000103dc6');
                const sendBuffer = new Uint8Array([0x01, 0x01, 0x02, 0x03, 0x00, 0xb9, 0x0c]);
                modbus.read(sendBuffer.buffer);
            },
        });

        const r = await modbus.unit(1).readCoilStatus(0, 16);
        expect(r.states[0]).toBe(true);
        expect(r.states[1]).toBe(true);
        expect(r.states[5]).toBe(false);
        expect(r.states[6]).toBe(false);
    });

    it('should support timeout', async (done) => {
        const modbus = new ModBus({
            timeout: 1000,
            write(buffer) {
                // DO NONTHING
            },
        });

        const now = Date.now();
        try {
            const r = await modbus.unit(1).readCoilStatus(0, 16);
        } catch (e) {
            expect(Date.now() - now).toBeGreaterThan(1000);
            expect(Date.now() - now).toBeLessThan(2000);
            done();
        }
    });


    it('should readInputRegisters()', () => {});

    it('should readHoldingRegisters()', async () => {});

    it('should writeCoil()', async () => {
        const modbus = new ModBus({
            write(buffer) {
                // => 0x01 0x05 0x00 0x01 0xFF 0x00 0xDD 0xFA
                // <= 0x01 0x05 0x00 0x01 0xFF 0x00 0xDD 0xFA
                expect(toHex(buffer)).toBe('01050001ff00ddfa');
                const sendBuffer = new Uint8Array([0x01, 0x05, 0x00, 0x01, 0xff, 0x00, 0xdd, 0xfa]);
                modbus.read(sendBuffer.buffer);
            },
        });

        const r = await modbus.unit(1).writeCoil(1, true);
        expect(r).toEqual({ address: 1, state: true });
    });

    it('should writeRegister()', async () => {
        const modbus = new ModBus({
            write(buffer) {
                expect(toHex(buffer)).toBe('6006000000208063');
                const sendBuffer = new Uint8Array([0x60, 0x06, 0x00, 0x00, 0x00, 0x20, 0x80, 0x63]);
                modbus.read(sendBuffer.buffer);
            },
        });

        let unit = modbus.unit(96);
        let r = await unit.writeRegister(0, 32);
        expect(r.address).toBe(0);
        expect(r.value).toBe(32);
    });

    it('should writeCoils()', () => {});

    it('should writeRegisters()', () => {});
});
