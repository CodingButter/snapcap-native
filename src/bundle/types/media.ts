/**
 * Media upload bundle shape — `Fi` mediaUploadDelegate. Single entry
 * because uploads share one delegate; the snap-vs-image distinction is
 * carried in the CreateContentMessage envelope, not in this pipeline.
 */

/**
 * `Fi` mediaUploadDelegate (chat module 76877). Surfaced by the
 * chat-bundle source-patch as `__SNAPCAP_FI`. The snap-vs-image
 * distinction lives in the `contentType` field on the CreateContentMessage
 * envelope, not in the upload pipeline — there is no separate
 * `uploadSnapMedia`.
 *
 * @internal Bundle wire-format type.
 */
export interface FiUpload {
  uploadMedia: (ctx: unknown, blob: unknown, meta: unknown) => Promise<unknown>;
  uploadMediaReferences: (ctx: unknown, refs: unknown) => Promise<unknown>;
}
