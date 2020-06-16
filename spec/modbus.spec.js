describe('ModBus', () => {
    const ModBus = require('../lib/index');

    it('should readCoilStatus()', () => {});

    it('should readInputRegisters()', () => {});

    it('should readHoldingRegisters()', async () => {});

    it('should writeCoil()', () => {});

    it('should writeRegister()', async () => {
        const modbus = new ModBus({
            write(buffer) {
                if (buffer.toString('hex') === '6006000000208063') {
                    modbus.read(Buffer.from([0x60, 0x06, 0x00, 0x00, 0x00, 0x20, 0x80, 0x63]));
                }
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
