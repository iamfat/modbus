# @genee/modbus: A ModBus Library

## Usage

```javascript
const port = new SerialPort('/dev/ttyS0', {
    baudRate: 38400,
    autoOpen: false,
});

const bus = new ModBus({
    logger: console,
    write: (chunk) => {
        port.write(chunk);
    },
});

port.on('data', (chunk) => {
    bus.read(chunk);
});

const data = await bus.unit(0x33).readRegisters();

```
