/**
 * Распаковка LZMA («.lzma alone»: 13-байтовый заголовок + поток) — формат файлов
 * истории Dukascopy (.bi5). Порт эталонного декодера из спецификации LZMA SDK
 * (Igor Pavlov, public domain), без внешних зависимостей.
 */

const PROB_BITS = 11;
const PROB_INIT = 1 << (PROB_BITS - 1);
const MOVE_BITS = 5;
const TOP = 1 << 24;

class RangeDecoder {
  range = 0xffffffff;
  code = 0;
  pos: number;
  constructor(
    private buf: Uint8Array,
    start: number,
  ) {
    this.pos = start;
    if (this.byte() !== 0) throw new Error('LZMA: повреждённый поток');
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
    if (this.code === this.range) throw new Error('LZMA: повреждённый поток');
  }
  private byte() {
    return this.pos < this.buf.length ? this.buf[this.pos++] : 0;
  }
  private normalize() {
    if (this.range < TOP) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
  }
  bit(probs: Uint16Array, i: number): number {
    const v = probs[i];
    const bound = (this.range >>> PROB_BITS) * v;
    let sym: number;
    if (this.code < bound) {
      probs[i] = v + (((1 << PROB_BITS) - v) >>> MOVE_BITS);
      this.range = bound;
      sym = 0;
    } else {
      probs[i] = v - (v >>> MOVE_BITS);
      this.code -= bound;
      this.range -= bound;
      sym = 1;
    }
    this.normalize();
    return sym;
  }
  direct(numBits: number): number {
    let res = 0;
    for (; numBits > 0; numBits--) {
      this.range >>>= 1;
      let b = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        b = 1;
      }
      res = ((res << 1) | b) >>> 0;
      this.normalize();
    }
    return res;
  }
  finishedOk() {
    return this.code === 0;
  }
}

function bitTree(rc: RangeDecoder, probs: Uint16Array, off: number, numBits: number) {
  let m = 1;
  for (let i = 0; i < numBits; i++) m = (m << 1) + rc.bit(probs, off + m);
  return m - (1 << numBits);
}

function bitTreeReverse(rc: RangeDecoder, probs: Uint16Array, off: number, numBits: number) {
  let m = 1;
  let sym = 0;
  for (let i = 0; i < numBits; i++) {
    const b = rc.bit(probs, off + m);
    m = (m << 1) + b;
    sym |= b << i;
  }
  return sym;
}

class LenDecoder {
  choice = new Uint16Array(2).fill(PROB_INIT);
  low = new Uint16Array(16 << 3).fill(PROB_INIT);
  mid = new Uint16Array(16 << 3).fill(PROB_INIT);
  high = new Uint16Array(256).fill(PROB_INIT);
  decode(rc: RangeDecoder, posState: number) {
    if (rc.bit(this.choice, 0) === 0) return bitTree(rc, this.low, posState << 3, 3);
    if (rc.bit(this.choice, 1) === 0) return 8 + bitTree(rc, this.mid, posState << 3, 3);
    return 16 + bitTree(rc, this.high, 0, 8);
  }
}

export function lzmaDecompress(input: Uint8Array): Uint8Array {
  if (input.length < 13) throw new Error('LZMA: слишком короткий файл');
  let d = input[0];
  if (d >= 9 * 5 * 5) throw new Error('LZMA: неверные свойства');
  const lc = d % 9;
  d = (d / 9) | 0;
  const lp = d % 5;
  const pb = (d / 5) | 0;
  let dictSize = 0;
  for (let i = 0; i < 4; i++) dictSize += input[1 + i] * 2 ** (8 * i);
  dictSize = Math.max(dictSize, 1 << 12);
  let sizeKnown = false;
  let unpackSize = 0;
  for (let i = 0; i < 8; i++) {
    const b = input[5 + i];
    if (b !== 0xff) sizeKnown = true;
    unpackSize += b * 2 ** (8 * i);
  }
  let out = new Uint8Array(sizeKnown ? unpackSize : Math.max(1024, input.length * 8));
  let outPos = 0;
  const put = (b: number) => {
    if (outPos >= out.length) {
      const n = new Uint8Array(out.length * 2);
      n.set(out);
      out = n;
    }
    out[outPos++] = b;
  };

  const rc = new RangeDecoder(input, 13);
  const lit = new Uint16Array(0x300 << (lc + lp)).fill(PROB_INIT);
  const posSlot = new Uint16Array(4 << 6).fill(PROB_INIT);
  const posDec = new Uint16Array(1 + 114).fill(PROB_INIT);
  const align = new Uint16Array(1 << 4).fill(PROB_INIT);
  const isMatch = new Uint16Array(12 << 4).fill(PROB_INIT);
  const isRep = new Uint16Array(12).fill(PROB_INIT);
  const isRepG0 = new Uint16Array(12).fill(PROB_INIT);
  const isRepG1 = new Uint16Array(12).fill(PROB_INIT);
  const isRepG2 = new Uint16Array(12).fill(PROB_INIT);
  const isRep0Long = new Uint16Array(12 << 4).fill(PROB_INIT);
  const lenDec = new LenDecoder();
  const repLenDec = new LenDecoder();

  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  let left = unpackSize;

  const decodeDistance = (len: number) => {
    const lenState = Math.min(len, 3);
    const slot = bitTree(rc, posSlot, lenState << 6, 6);
    if (slot < 4) return slot;
    const numDirect = (slot >>> 1) - 1;
    let dist = ((2 | (slot & 1)) << numDirect) >>> 0;
    if (slot < 14) dist += bitTreeReverse(rc, posDec, dist - slot, numDirect);
    else {
      dist += rc.direct(numDirect - 4) * 16;
      dist += bitTreeReverse(rc, align, 0, 4);
    }
    return dist >>> 0;
  };

  for (;;) {
    if (sizeKnown && left === 0 && rc.finishedOk()) break;
    const posState = outPos & pbMask;
    if (rc.bit(isMatch, (state << 4) + posState) === 0) {
      if (sizeKnown && left === 0) throw new Error('LZMA: лишние данные');
      const prev = outPos > 0 ? out[outPos - 1] : 0;
      const off = 0x300 * (((outPos & lpMask) << lc) + (prev >>> (8 - lc)));
      let sym = 1;
      if (state >= 7) {
        let match = out[outPos - rep0 - 1];
        do {
          const mb = (match >>> 7) & 1;
          match <<= 1;
          const b = rc.bit(lit, off + ((1 + mb) << 8) + sym);
          sym = (sym << 1) | b;
          if (mb !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | rc.bit(lit, off + sym);
      put(sym - 0x100);
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      left--;
      continue;
    }
    let len: number;
    if (rc.bit(isRep, state) !== 0) {
      if (outPos === 0) throw new Error('LZMA: повреждённый поток');
      if (rc.bit(isRepG0, state) === 0) {
        if (rc.bit(isRep0Long, (state << 4) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          put(out[outPos - rep0 - 1]);
          left--;
          continue;
        }
      } else {
        let dist: number;
        if (rc.bit(isRepG1, state) === 0) dist = rep1;
        else {
          if (rc.bit(isRepG2, state) === 0) dist = rep2;
          else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = repLenDec.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = lenDec.decode(rc, posState);
      state = state < 7 ? 7 : 10;
      rep0 = decodeDistance(len);
      if (rep0 === 0xffffffff) break; // маркер конца потока
      if (rep0 >= outPos) throw new Error('LZMA: неверная дистанция');
    }
    len += 2;
    if (sizeKnown && len > left) throw new Error('LZMA: выход за размер');
    for (let i = 0; i < len; i++) put(out[outPos - rep0 - 1]);
    left -= len;
  }
  return out.subarray(0, outPos);
}
