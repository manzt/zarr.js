import { DtypeString } from '../types';
import { ValueError } from '../errors';

export type NestedArrayData = TypedArray | NDNestedArrayData;
export type NDNestedArrayData =
  | TypedArray[]
  | TypedArray[][]
  | TypedArray[][][]
  | TypedArray[][][][]
  | TypedArray[][][][][]
  | TypedArray[][][][][][];

export type TypedArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

// ArrayLike<any> & {
//     BYTES_PER_ELEMENT: number;
//     set(array: ArrayLike<number>, offset?: number): void;
//     slice(start?: number, end?: number): TypedArray;
//     subarray(start?: number, end?: number): TypedArray;
//     buffer: Buffer | ArrayBuffer;
//     constructor: TypedArrayConstructor<TypedArray>;
// };
export type TypedArrayConstructor<TypedArray> = {
  new(): TypedArray;
  // tslint:disable-next-line: unified-signatures
  new(size: number): TypedArray;
  // tslint:disable-next-line: unified-signatures
  new(buffer: ArrayBuffer): TypedArray;
  BYTES_PER_ELEMENT: number;
};

export const DTYPE_TYPEDARRAY_MAPPING: { [A in DtypeString]: TypedArrayConstructor<TypedArray> } = {
  '|b': Int8Array,
  '|B': Uint8Array,
  '|u1': Uint8Array,
  '|i1': Int8Array,
  '<b': Int8Array,
  '<B': Uint8Array,
  '<u1': Uint8Array,
  '<i1': Int8Array,
  '<u2': Uint16Array,
  '<i2': Int16Array,
  '<u4': Uint32Array,
  '<i4': Int32Array,
  '<f4': Float32Array,
  '<f8': Float64Array,
  '>b': Int8Array,
  '>B': Uint8Array,
  '>u1': Uint8Array,
  '>i1': Int8Array,
  '>u2': Uint16Array,
  '>i2': Int16Array,
  '>u4': Uint32Array,
  '>i4': Int32Array,
  '>f4': Float32Array,
  '>f8': Float64Array
};

/*
 * Called by NestedArray and RawArray constructors only.
 * We byte-swap the buffer of a store after decoding
 * since TypedArray views are little endian only.
 *
 * This means NestedArrays and RawArrays will always be little endian,
 * unless a numpy-like library comes around and can handle endianess
 * for buffer views.
 */
export function getTypedArrayDtypeString(t: TypedArray): DtypeString {
  // Favour the types below instead of small and big B
  if (t instanceof Uint8Array) return '|u1';
  if (t instanceof Int8Array) return '|i1';
  if (t instanceof Uint16Array) return '<u2';
  if (t instanceof Int16Array) return '<i2';
  if (t instanceof Uint32Array) return '<u4';
  if (t instanceof Int32Array) return '<i4';
  if (t instanceof Float32Array) return '<f4';
  if (t instanceof Float64Array) return '<f8';
  throw new ValueError('Mapping for TypedArray to Dtypestring not known');
}
