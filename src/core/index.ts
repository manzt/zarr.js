import { Store, ValidStoreType, AsyncStore, SyncStore } from "../storage/types";

import { pathToPrefix } from "../storage/index";
import { normalizeStoragePath, isTotalSlice, arrayEquals1D } from "../util";
import { ZarrArrayMetadata, UserAttributes, FillType } from "../types";
import { ARRAY_META_KEY, ATTRS_META_KEY } from "../names";
import { Attributes } from "../attributes";
import { parseMetadata } from "../metadata";
import { ArraySelection, DimensionSelection, Indexer, Slice } from "./types";
import { BasicIndexer, isContiguousSelection } from "./indexing";
import { NestedArray } from "../nestedArray";
import { TypedArray, DTYPE_TYPEDARRAY_MAPPING } from "../nestedArray/types";
import { ValueError, PermissionError, KeyError } from "../errors";
import { Codec } from "../compression/types";
import { getCodec } from "../compression/creation";

export class ZarrArray {
  public store: Store;
  private compressor: Codec | null;

  private _chunkStore: Store | null;
  /**
   * A `Store` providing the underlying storage for array chunks.
   */
  public get chunkStore(): Store {
    if (this._chunkStore) {
      return this._chunkStore;
    }
    return this.store;
  }
  public path: string;
  public keyPrefix: string;
  public readOnly: boolean;
  public cacheMetadata: boolean;
  public cacheAttrs: boolean;
  public meta: ZarrArrayMetadata;
  public attrs: Attributes<UserAttributes>;

  /**
   * Array name following h5py convention.
   */
  public get name(): string | null {
    if (this.path.length > 0) {
      if (this.path[0] !== "/") {
        return "/" + this.path;
      }
      return this.path;
    }
    return null;
  }

  /**
   * Final component of name.
   */
  public get basename(): string | null {
    const name = this.name;
    if (name === null) {
      return null;
    }
    const parts = name.split("/");
    return parts[parts.length - 1];
  }

  /**
   * "A list of integers describing the length of each dimension of the array.
   */
  public get shape(): number[] {
    // this.refreshMetadata();
    return this.meta.shape;
  }

  /**
   * A list of integers describing the length of each dimension of a chunk of the array.
   */
  public get chunks(): number[] {
    return this.meta.chunks;
  }

  /**
   * Integer describing how many element a chunk contains
   */
  private get chunkSize(): number {
    return this.chunks.reduce((x, y) => x * y, 1);
  }

  /**
   *  The NumPy data type.
   */
  public get dtype() {
    return this.meta.dtype;
  }

  /**
   *  A value used for uninitialized portions of the array.
   */
  public get fillValue(): FillType {
    const fillTypeValue = this.meta.fill_value;

    // TODO extract into function
    if (fillTypeValue === "NaN") {
      return NaN;
    } else if (fillTypeValue === "Infinity") {
      return Infinity;
    } else if (fillTypeValue === "-Infinity") {
      return -Infinity;
    }

    return this.meta.fill_value as FillType;
  }

  /**
   *  Number of dimensions.
   */
  public get nDims() {
    return this.meta.shape.length;
  }

  /**
   *  The total number of elements in the array.
   */
  public get size() {
    // this.refreshMetadata()
    return this.meta.shape.reduce((x, y) => x * y, 1);
  }

  public get length() {
    return this.shape[0];
  }

  private get _chunkDataShape() {
    if (this.shape === []) {
      return [1];
    } else {
      const s = [];
      for (let i = 0; i < this.shape.length; i++) {
        s[i] = Math.ceil(this.shape[i] / this.chunks[i]);
      }
      return s;
    }
  }
  /**
   * A tuple of integers describing the number of chunks along each
   * dimension of the array.
   */
  public get chunkDataShape() {
    // this.refreshMetadata();
    return this._chunkDataShape;
  }

  /**
   * Total number of chunks.
   */
  public get numChunks() {
    // this.refreshMetadata();
    return this.chunkDataShape.reduce((x, y) => x * y, 1);
  }

  /**
   * Instantiate an array from an initialized store.
   * @param store Array store, already initialized.
   * @param path Storage path.
   * @param readOnly True if array should be protected against modification.
   * @param chunkStore Separate storage for chunks. If not provided, `store` will be used for storage of both chunks and metadata.
   * @param cacheMetadata If true (default), array configuration metadata will be cached for the lifetime of the object.
   * If false, array metadata will be reloaded prior to all data access and modification operations (may incur overhead depending on storage and data access pattern).
   * @param cacheAttrs If true (default), user attributes will be cached for attribute read operations.
   * If false, user attributes are reloaded from the store prior to all attribute read operations.
   */
  public static async create(
    store: Store,
    path: null | string = null,
    readOnly: boolean = false,
    chunkStore: Store | null = null,
    cacheMetadata = true,
    cacheAttrs = true
  ) {
    const metadata = await this.loadMetadataForConstructor(store, path);
    return new ZarrArray(
      store,
      path,
      metadata as ZarrArrayMetadata,
      readOnly,
      chunkStore,
      cacheMetadata,
      cacheAttrs
    );
  }

  private static async loadMetadataForConstructor(store: Store, path: null | string) {
    try {
      path = normalizeStoragePath(path);
      const keyPrefix = pathToPrefix(path);
      const metaStoreValue = await store.getItem(keyPrefix + ARRAY_META_KEY);
      return parseMetadata(metaStoreValue);
    } catch (error) {
      throw new Error("Failed to load metadata for ZarrArray:" + error.toString());
    }
  }

  /**
   * Instantiate an array from an initialized store.
   * @param store Array store, already initialized.
   * @param path Storage path.
   * @param metadata The initial value for the metadata
   * @param readOnly True if array should be protected against modification.
   * @param chunkStore Separate storage for chunks. If not provided, `store` will be used for storage of both chunks and metadata.
   * @param cacheMetadata If true (default), array configuration metadata will be cached for the lifetime of the object.
   * If false, array metadata will be reloaded prior to all data access and modification operations (may incur overhead depending on storage and data access pattern).
   * @param cacheAttrs If true (default), user attributes will be cached for attribute read operations.
   * If false, user attributes are reloaded from the store prior to all attribute read operations.
   */
  private constructor(
    store: Store,
    path: null | string = null,
    metadata: ZarrArrayMetadata,
    readOnly: boolean = false,
    chunkStore: Store | null = null,
    cacheMetadata = true,
    cacheAttrs = true
  ) {
    // N.B., expect at this point store is fully initialized with all
    // configuration metadata fully specified and normalized

    this.store = store;
    this._chunkStore = chunkStore;
    this.path = normalizeStoragePath(path);
    this.keyPrefix = pathToPrefix(this.path);
    this.readOnly = readOnly;
    this.cacheMetadata = cacheMetadata;
    this.cacheAttrs = cacheAttrs;
    this.meta = metadata;
    if (this.meta.compressor !== null) {
      this.compressor = getCodec(this.meta.compressor);
    } else {
      this.compressor = null;
    }

    const attrKey = this.keyPrefix + ATTRS_META_KEY;
    this.attrs = new Attributes<UserAttributes>(this.store, attrKey, this.readOnly, cacheAttrs);
  }

  /**
   * (Re)load metadata from store
   */
  public async reloadMetadata() {
    const metaKey = this.keyPrefix + ARRAY_META_KEY;
    const metaStoreValue = this.store.getItem(metaKey);
    this.meta = parseMetadata(await metaStoreValue) as ZarrArrayMetadata;
    return this.meta;
  }

  private async refreshMetadata() {
    if (!this.cacheMetadata) {
      await this.reloadMetadata();
    }
  }

  public get(
    selection?: undefined | Slice | ":" | "..." | null | (Slice | null | ":" | "...")[]
  ): Promise<NestedArray<TypedArray>>;
  public get(selection?: ArraySelection): Promise<NestedArray<TypedArray> | number>;
  public get(selection: ArraySelection = null): Promise<NestedArray<TypedArray> | number> {
    return this.getBasicSelection(selection);
  }

  public async getBasicSelection(
    selection: Slice | ":" | "..." | null | (Slice | null | ":" | "...")[]
  ): Promise<NestedArray<TypedArray>>;
  public async getBasicSelection(
    selection: ArraySelection
  ): Promise<NestedArray<TypedArray> | number>;
  public async getBasicSelection(
    selection: ArraySelection
  ): Promise<number | NestedArray<TypedArray>> {
    // Refresh metadata
    if (!this.cacheMetadata) {
      await this.reloadMetadata();
    }

    // Check fields (TODO?)

    if (this.shape === []) {
      throw new Error("Shape [] indexing is not supported yet");
    } else {
      return this.getBasicSelectionND(selection);
    }
  }

  private getBasicSelectionND(selection: ArraySelection) {
    const indexer = new BasicIndexer(selection, this);
    return this.getSelection(indexer);
  }

  private async getSelection(indexer: BasicIndexer) {
    // We iterate over all chunks which overlap the selection and thus contain data
    // that needs to be extracted. Each chunk is processed in turn, extracting the
    // necessary data and storing into the correct location in the output array.

    // N.B., it is an important optimisation that we only visit chunks which overlap
    // the selection. This minimises the number of iterations in the main for loop.

    // check fields are sensible (TODO?)

    const outDtype = this.dtype;
    const outShape = indexer.shape;
    const outSize = indexer.shape.reduce((x, y) => x * y, 1);
    const out = new NestedArray(null, outShape, outDtype);

    if (outSize === 0) {
      return out;
    }

    for (let proj of indexer.iter()) {
      await this.chunkGetItem(
        proj.chunkCoords,
        proj.chunkSelection,
        out,
        proj.outSelection,
        indexer.dropAxes
      );
    }

    // Return scalar instead of zero-dimensional array.
    if (out.shape.length === 0) {
      return out.data[0] as number;
    }

    return out;
  }

  /**
   * Obtain part or whole of a chunk.
   * @param chunkCoords Indices of the chunk.
   * @param chunkSelection Location of region within the chunk to extract.
   * @param out Array to store result in.
   * @param outSelection Location of region within output array to store results in.
   * @param dropAxes Axes to squeeze out of the chunk.
   */
  private async chunkGetItem<T extends TypedArray>(
    chunkCoords: number[],
    chunkSelection: DimensionSelection[],
    out: NestedArray<T>,
    outSelection: DimensionSelection[],
    dropAxes: null | number[]
  ) {
    if (chunkCoords.length !== this._chunkDataShape.length) {
      throw new ValueError(
        `Inconsistent shapes: chunkCoordsLength: ${chunkCoords.length}, cDataShapeLength: ${this.chunkDataShape.length}`
      );
    }

    const cKey = this.chunkKey(chunkCoords);
    // TODO may be better to ask for forgiveness instead
    if (await this.chunkStore.containsItem(cKey)) {
      const cdata = this.chunkStore.getItem(cKey);
      if (
        isContiguousSelection(outSelection) &&
        isTotalSlice(chunkSelection, this.chunks) &&
        !this.meta.filters
      ) {
        // Optimization: we want the whole chunk, and the destination is
        // contiguous, so we can decompress directly from the chunk
        // into the destination array

        // TODO check order
        // TODO filters..
        out.set(outSelection, this.toNestedArray<T>(this.decodeChunk(await cdata)));
        return;
      }
      // Decode chunk
      const chunk = this.toNestedArray(this.decodeChunk(await cdata));
      const tmp = chunk.get(chunkSelection);

      if (dropAxes !== null) {
        throw new Error("Drop axes is not supported yet");
      }

      out.set(outSelection, tmp as NestedArray<T>);
    } else {
      // Chunk isn't there, use fill value
      if (this.fillValue !== null) {
        out.set(outSelection, this.fillValue);
      }
    }
  }

  private chunkKey(chunkCoords: number[]) {
    return this.keyPrefix + chunkCoords.join(".");
  }

  private ensureByteArray(chunkData: ValidStoreType): Uint8Array {
    if (typeof chunkData === "string") {
      return new Uint8Array(Buffer.from(chunkData).buffer);
    }
    return new Uint8Array(chunkData);
  }

  private toTypedArray(buffer: Buffer | ArrayBuffer) {
    return new DTYPE_TYPEDARRAY_MAPPING[this.dtype](buffer);
  }

  private toNestedArray<T extends TypedArray>(data: ValidStoreType) {
    const buffer = this.ensureByteArray(data).buffer;

    return new NestedArray<T>(buffer, this.chunks, this.dtype);
  }

  private decodeChunk(chunkData: ValidStoreType) {
    const byteChunkData = this.ensureByteArray(chunkData);

    if (this.compressor !== null) {
      return this.compressor.decode(byteChunkData as any);
    }

    // TODO filtering etc
    return byteChunkData.buffer;
  }

  public async set(selection: ArraySelection = null, value: any) {
    await this.setBasicSelection(selection, value);
  }

  public async setBasicSelection(selection: ArraySelection, value: any) {
    if (this.readOnly) {
      throw new PermissionError("Object is read only");
    }

    if (!this.cacheMetadata) {
      await this.reloadMetadata();
    }

    if (this.shape === []) {
      throw new Error("Shape [] indexing is not supported yet");
    } else {
      await this.setBasicSelectionND(selection, value);
    }
  }

  private async setBasicSelectionND(selection: ArraySelection, value: any) {
    const indexer = new BasicIndexer(selection, this);
    await this.setSelection(indexer, value);
  }

  private async setSelection(indexer: Indexer, value: number | NestedArray<TypedArray>) {
    // We iterate over all chunks which overlap the selection and thus contain data
    // that needs to be replaced. Each chunk is processed in turn, extracting the
    // necessary data from the value array and storing into the chunk array.

    // N.B., it is an important optimisation that we only visit chunks which overlap
    // the selection. This minimises the number of iterations in the main for loop.

    // TODO? check fields are sensible

    // Determine indices of chunks overlapping the selection
    const selectionShape = indexer.shape;

    // Check value shape
    if (selectionShape === []) {
      // Setting a single value
    } else if (typeof value === "number") {
      // Setting a scalar value
    } else if (value instanceof NestedArray) {
      // TODO: non stringify equality check
      if (!arrayEquals1D(value.shape, selectionShape)) {
        throw new ValueError(
          `Shape mismatch in source NestedArray and set selection: ${value.shape} and ${selectionShape}`
        );
      }
    } else {
      // TODO support TypedArrays, buffers, etc
      throw new Error("Unknown data type for setting :(");
    }

    // Iterate over chunks in range
    for (let proj of indexer.iter()) {
      let chunkValue = null;

      if (selectionShape === []) {
        chunkValue = value;
      } else if (typeof value === "number") {
        chunkValue = value;
      } else {
        chunkValue = value.get(proj.outSelection);
        // tslint:disable-next-line: strict-type-predicates
        if (indexer.dropAxes !== null) {
          throw new Error("Handling drop axes not supported yet");
        }
      }

      await this.chunkSetItem(proj.chunkCoords, proj.chunkSelection, chunkValue);
    }
  }

  private async chunkSetItem<T extends TypedArray>(
    chunkCoords: number[],
    chunkSelection: DimensionSelection[],
    value: number | NestedArray<TypedArray>
  ) {
    // Obtain key for chunk storage
    const chunkKey = this.chunkKey(chunkCoords);

    let chunk: null | TypedArray = null;

    const dtypeConstr = DTYPE_TYPEDARRAY_MAPPING[this.dtype];
    const chunkSize = this.chunkSize;

    if (isTotalSlice(chunkSelection, this.chunks)) {
      // Totally replace chunk

      // Optimization: we are completely replacing the chunk, so no need
      // to access the existing chunk data

      if (typeof value === "number") {
        // TODO get the right type here
        chunk = new dtypeConstr(chunkSize);
        chunk.fill(value);
      } else {
        chunk = value.flatten();
      }
    } else {
      // partially replace the contents of this chunk

      // Existing chunk data
      let chunkData: TypedArray;

      try {
        // Chunk is initialized if this does not error
        const chunkStoreData = this.chunkStore.getItem(chunkKey);
        chunkData = this.toTypedArray(this.decodeChunk(await chunkStoreData));
      } catch (error) {
        if (error instanceof KeyError) {
          // Chunk is not initialized
          chunkData = new dtypeConstr(chunkSize);
          if (this.fillValue !== null) {
            chunkData.fill(this.fillValue);
          }
        } else {
          // Different type of error - rethrow
          throw error;
        }
      }

      const chunkNestedArray = new NestedArray(chunkData, this.chunks, this.dtype);
      chunkNestedArray.set(chunkSelection, value);
      chunk = chunkNestedArray.flatten();
    }
    const chunkData = this.encodeChunk(chunk);
    this.chunkStore.setItem(chunkKey, chunkData);
  }

  private encodeChunk(chunk: TypedArray) {
    if (this.compressor !== null) {
      return this.compressor.encode(new Uint8Array(chunk.buffer));
    }
    // TODO: filters, etc
    return chunk.buffer;
  }
}
