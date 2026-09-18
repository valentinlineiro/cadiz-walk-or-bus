export class SearchDestinationsUseCase {
    geocoding;
    constructor(geocoding) {
        this.geocoding = geocoding;
    }
    async execute(query, limit) {
        return this.geocoding.search(query, limit);
    }
}
