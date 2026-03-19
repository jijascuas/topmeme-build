export const BannerAd = () => null;
export const BannerAdSize = {};
export const InterstitialAd = {
  createForAdRequest: () => ({
    load: () => {},
    show: () => {},
    addAdEventListener: () => () => {},
    loaded: false
  })
};
export const AdEventType = { LOADED: 'LOADED', CLOSED: 'CLOSED' };
