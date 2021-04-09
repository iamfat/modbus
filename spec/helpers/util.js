const hexEncodeArray = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];

const toHex = function (value, sep = '') {
    let s = '';
    let arr;
    if (typeof value === 'number') {
        arr = [];
        while (value > 0) {
            arr.unshift(value & 0xff);
            value >>= 8;
        }
        if (arr.length === 0) {
            arr.push(0);
        }
    } else if (value instanceof ArrayBuffer) {
        arr = new Uint8Array(value);
    } else {
        arr = value;
    }
    for (let i = 0; i < arr.length; i++) {
        const code = arr[i];
        s += `${hexEncodeArray[code >>> 4] || 0}${hexEncodeArray[code & 0x0f] || 0}${sep}`;
    }
    return s.trim();
};

module.exports = { toHex }
