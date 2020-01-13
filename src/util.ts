import { Order, FillType, ChunksArgument, DtypeString } from "./types";

import { createCheckers } from "ts-interface-checker";
import typesTI from "../src/types-ti";
import { DimensionSelection, Slice } from "./core/types";
import { isSlice } from "./core/indexing";

const TypeCheckSuite = createCheckers(typesTI);

export function humanReadableSize(size: number) {
  if (size < 2 ** 10) {
    return `${size}`;
  } else if (size < 2 ** 20) {
    return `${(size / 2 ** 10).toFixed(1)}K`;
  } else if (size < 2 ** 30) {
    return `${(size / 2 ** 20).toFixed(1)}M`;
  } else if (size < 2 ** 40) {
    return `${(size / 2 ** 30).toFixed(1)}G`;
  } else if (size < 2 ** 50) {
    return `${(size / 2 ** 40).toFixed(1)}T`;
  }
  return `${(size / 2 ** 50).toFixed(1)}P`;
}

export function normalizeStoragePath(path: string | String | null): string {
  if (path === null) {
    return "";
  }

  if (path instanceof String) {
    path = path.valueOf();
  }

  // convert backslash to forward slash
  path = path.replace(/\\/g, "/");
  // ensure no leading slash
  while (path.length > 0 && path[0] === "/") {
    path = path.slice(1);
  }

  // ensure no trailing slash
  while (path.length > 0 && path[path.length - 1] === "/") {
    path = path.slice(0, path.length - 1);
  }

  // collapse any repeated slashes
  path = path.replace(/\/\/+/g, "/");

  // don't allow path segments with just '.' or '..'
  const segments = path.split("/");

  for (const s of segments) {
    if (s === "." || s === "..") {
      throw Error("path containing '.' or '..' segment not allowed");
    }
  }
  return path as string;
}

export function normalizeShape(shape: number | number[]): number[] {
  if (typeof shape === "number") {
    shape = [shape];
  }
  return shape.map(x => Math.floor(x));
}

export function normalizeChunks(chunks: ChunksArgument, shape: number[]): number[] {
  // Assume shape is already normalized

  TypeCheckSuite.ChunksArgument.check(chunks);

  if (chunks === null || chunks === true) {
    throw new Error("Chunk guessing is not supported yet");
  }

  if (chunks === false) {
    return shape;
  }

  if (typeof chunks === "number") {
    chunks = [chunks];
  }

  // handle underspecified chunks
  if (chunks.length < shape.length) {
    // assume chunks across remaining dimensions
    chunks = chunks.concat(shape.slice(chunks.length));
  }

  return chunks.map((x, idx) => {
    // handle null or -1 in chunks
    if (x === -1 || x === null) {
      return shape[idx];
    } else {
      return Math.floor(x);
    }
  });
}

export function normalizeOrder(order: string): Order {
  order = order.toUpperCase();

  TypeCheckSuite.Order.check(order);
  return order as Order;
}

export function normalizeDtype(dtype: DtypeString): DtypeString {
  TypeCheckSuite.DtypeString.check(dtype);
  return dtype;
}

export function normalizeFillValue(fillValue: FillType): FillType {
  TypeCheckSuite.FillType.check(fillValue);
  return fillValue;
}

/**
 * Determine whether `item` specifies a complete slice of array with the
 *  given `shape`. Used to optimize __setitem__ operations on chunks
 * @param item
 * @param shape
 */
export function isTotalSlice(
  item: DimensionSelection | DimensionSelection[],
  shape: number[]
): boolean {
  if (item === null) {
    return true;
  }
  if (!Array.isArray(item)) {
    item = [item];
  }

  for (let i = 0; i < Math.min(item.length, shape.length); i++) {
    const it = item[i];
    if (it === null) continue;

    if (isSlice(it)) {
      const s = it as Slice;
      const isStepOne = s.step === 1 || s.step === null;

      if (s.start === null && s.stop === null && isStepOne) {
        continue;
      }
      if ((s.stop as number) - (s.start as number) === shape[i] && isStepOne) {
        continue;
      }
      return false;
    }
    return false;

    // } else {
    //     console.error(`isTotalSlice unexpected non-slice, got ${it}`);
    //     return false;
    // }
  }
  return true;
}

/**
 * Checks for === equality of all elements.
 */
export function arrayEquals1D(a: ArrayLike<any>, b: ArrayLike<any>) {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
