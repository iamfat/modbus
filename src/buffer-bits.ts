declare interface Buffer {
  writeBit(value: boolean, bit: number, offset: number);
  readBit(bit: number, offset: number): boolean;
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

Buffer.prototype.readBit = function (bit: number, offset = 0) {
  let byteOffset = Math.floor(offset + bit / 8);
  let bitOffset = bit % 8;
  let bitMask = 0x1 << bitOffset;

  // get byte from buffer
  let byte = this.readUInt8(byteOffset);

  // check bit state
  return (byte & bitMask) === bitMask;
};
