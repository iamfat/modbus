const hexEncodeArray = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'];
export const toHex = (value: ArrayLike<number> | number | ArrayBuffer, sep = ''): string => {
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

export const customAlphabet = (alphabet) => {
    return (size) => {
        let id = '';
        // A compact alternative for `for (var i = 0; i < step; i++)`.
        let i = size;
        while (i--) {
            // `| 0` is more compact and faster than `Math.floor()`.
            id += alphabet[(Math.random() * alphabet.length) | 0];
        }
        return id;
    };
};

export const nanoid = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz');
