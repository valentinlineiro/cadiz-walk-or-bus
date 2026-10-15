/**
 * The provider could not be asked or did not give a usable answer. Distinct from an empty
 * result: `[]` means "asked, nothing matches". The message is safe to show; the cause is for logs.
 */
export class GeocodingUnavailableError extends Error {
    constructor(options) {
        super('Destination search is unavailable', options);
        this.name = 'GeocodingUnavailableError';
    }
}
