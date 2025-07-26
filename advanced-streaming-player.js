import { fromEvent, Subject, BehaviorSubject, merge, interval, of, from } from 'rxjs'
import { map, filter, switchMap, debounceTime, distinctUntilChanged, takeUntil} from 'rxjs/operators'
import axios from 'axios'

/**
 * Advanced Streaming Video Player with adaptive bitrate and concurrent segment downloading
 * @intuition Create a production-grade streaming player for React-based video applications
 * @approach Utilize RxJS for reactive programming, MediaSource Extensions for playback, and intelligent caching
 * @complexity Time: O(n) for segment processing, Space: O(k) where k is cache size
 */
export class AdvancedStreamingPlayer {
  constructor(options = {}) {
    this.config = {
      bufferSize: options.bufferSize || 30,
      maxRetries: options.maxRetries || 3,
      segmentTimeout: options.segmentTimeout || 10000,
      prefetchSegments: options.prefetchSegments || 5,
      maxConcurrentDownloads: options.maxConcurrentDownloads || 6,
      adaptiveBitrateThreshold: options.adaptiveBitrateThreshold || 0.8,
      cdnFailoverDelay: options.cdnFailoverDelay || 2000,
      checksumValidation: options.checksumValidation || true,
      ...options
    }

    this.mediaSource = null
    this.sourceBuffers = new Map()
    this.segmentCache = new Map()
    this.downloadQueue = new Map()
    this.currentManifest = null
    this.currentBitrate = null
    this.availableTracks = new Map()
    this.activeTracks = new Map()
    
    // State saving properties
    this.contentId = options.contentId || null
    this.stateSaveSubscription = null
    this.errorCount = 0
    this.lastError = null
    this.adaptiveBitrateEnabled = true
    
    this.networkQuality$ = new BehaviorSubject(1.0)
    this.playbackState$ = new BehaviorSubject({ position: 0, buffered: [], seeking: false })
    this.errorEvents$ = new Subject()
    this.destroy$ = new Subject()

    this.bandwidthEstimator = new BandwidthEstimator()
    this.segmentDownloader = new SegmentDownloader(this.config, this.bandwidthEstimator)
    this.adaptiveBitrateController = new AdaptiveBitrateController(this.config, this.networkQuality$)
    
    this.setupNetworkMonitoring()
    this.setupErrorTracking()
  }

  /**
   * Initialize player with manifest URL and video element
   * @intuition Load manifest, setup MediaSource, and prepare for playback
   * @approach Sequential loading: manifest → MediaSource → source buffers → initial segments
   * @complexity Time: O(1), Space: O(1)
   */
  async initialize(manifestUrl, videoElement) {
    try {
      this.videoElement = videoElement
      this.manifest = await this.loadManifest(manifestUrl)
      
      // Setup adaptive bitrate AFTER manifest is loaded
      this.setupAdaptiveBitrate()
      this.startPlaybackStateSaving()

      
      this.mediaSource = new MediaSource()
      this.videoElement.src = URL.createObjectURL(this.mediaSource)
      
      return new Promise((resolve, reject) => {
        this.mediaSource.addEventListener('sourceopen', async () => {
          try {
            await this.setupSourceBuffers()
            await this.startPlayback()
            resolve()
          } catch (error) {
            reject(error)
          }
        })
        
        this.mediaSource.addEventListener('error', reject)
        setTimeout(() => reject(new Error('MediaSource initialization timeout')), 10000)
      })
    } catch (error) {
      this.errorEvents$.next({ type: 'initialization', error })
      throw error
    }
  }

/**
 * Load manifest with enhanced parsing and CDN failover
 * @intuition Load streaming manifest with comprehensive format support
 * @approach Try multiple CDNs with format detection and parsing
 * @complexity Time: O(n*m) where n is CDN count and m is manifest size, Space: O(k) where k is variants count
 */
async loadManifest(manifestUrl) {
  this.manifestUrl = manifestUrl
  const cdnUrls = Array.isArray(manifestUrl) ? manifestUrl : [manifestUrl]
  
  for (let i = 0; i < cdnUrls.length; i++) {
    try {
      const response = await axios.get(cdnUrls[i], { 
        timeout: this.config.segmentTimeout,
        headers: {
          'Accept': 'application/vnd.apple.mpegurl, application/dash+xml, application/x-mpegURL, */*'
        }
      })
      
      const manifestData = response.data
      const baseUrl = this.extractBaseUrl(cdnUrls[i])
      
      // Parse manifest based on format
      const parsed = this.parseManifest(manifestData, baseUrl)
      parsed.cdnIndex = i
      parsed.cdnUrls = cdnUrls
      
      // Extract available tracks
      this.extractAvailableTracks(parsed)
      
      this.currentManifest = parsed
      return parsed
      
    } catch (error) {
      console.warn(`Failed to load manifest from CDN ${i}:`, error)
      if (i === cdnUrls.length - 1) {
        throw new Error(`Failed to load manifest from all CDNs: ${error.message}`)
      }
      await this.delay(this.config.cdnFailoverDelay)
    }
  }
}

/**
 * Parse manifest with format detection
 * @intuition Detect and parse HLS or DASH manifests
 * @approach Check content type and delegate to appropriate parser
 * @complexity Time: O(n) where n is manifest lines, Space: O(m) where m is variants count
 */
parseManifest(data, baseUrl) {
  if (typeof data === 'string') {
    if (data.includes('#EXTM3U') || data.includes('#EXT-X-VERSION')) {
      return this.parseHLSManifest(data, baseUrl)
    } else if (data.includes('<MPD') || data.includes('<?xml')) {
      return this.parseDASHManifest(data, baseUrl)
    }
  }
  
  throw new Error('Unsupported manifest format')
}

/**
 * Parse HLS manifest format
 * @intuition Extract variants, tracks, and segments from HLS
 * @approach Line-by-line parsing with state machine
 * @complexity Time: O(n) where n is manifest lines, Space: O(m) where m is variants count
 */
parseHLSManifest(manifestData, baseUrl) {
  const lines = manifestData.split('\n').filter(line => line.trim())
  const manifest = {
    type: 'hls',
    variants: [],
    audioTracks: [],
    subtitleTracks: [],
    segments: new Map(),
    baseUrl
  }
  
  let currentVariant = null
  let currentTrack = null
  let segmentIndex = 0
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bandwidth = parseInt(line.match(/BANDWIDTH=(\d+)/)?.[1] || '0')
      const resolution = line.match(/RESOLUTION=(\d+x\d+)/)?.[1]
      const codecs = line.match(/CODECS="([^"]+)"/)?.[1] || ''
      const audio = line.match(/AUDIO="([^"]+)"/)?.[1]
      const subtitles = line.match(/SUBTITLES="([^"]+)"/)?.[1]
      
      currentVariant = {
        id: `variant_${manifest.variants.length}`,
        bandwidth,
        resolution,
        codecs,
        audio,
        subtitles,
        segments: [],
        url: null
      }
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const type = line.match(/TYPE=(\w+)/)?.[1]
      const groupId = line.match(/GROUP-ID="([^"]+)"/)?.[1]
      const name = line.match(/NAME="([^"]+)"/)?.[1]
      const language = line.match(/LANGUAGE="([^"]+)"/)?.[1]
      const uri = line.match(/URI="([^"]+)"/)?.[1]
      const autoselect = line.includes('AUTOSELECT=YES')
      const defaultTrack = line.includes('DEFAULT=YES')
      
      currentTrack = {
        id: `${type.toLowerCase()}_${groupId}_${manifest.audioTracks.length + manifest.subtitleTracks.length}`,
        type: type.toLowerCase(),
        groupId,
        name,
        language,
        uri: uri ? this.resolveUrl(uri, baseUrl) : null,
        autoselect,
        default: defaultTrack,
        segments: [],
        codec: this.extractCodecForTrackType(type, codecs)
      }
      
      if (type === 'AUDIO') {
        manifest.audioTracks.push(currentTrack)
      } else if (type === 'SUBTITLES') {
        manifest.subtitleTracks.push(currentTrack)
      }
    } else if (line.startsWith('#EXTINF:')) {
      const duration = parseFloat(line.match(/#EXTINF:([\d.]+)/)?.[1] || '0')
      const nextLine = lines[i + 1]?.trim()
      
      if (nextLine && !nextLine.startsWith('#')) {
        const segment = {
          index: segmentIndex++,
          duration,
          url: this.resolveUrl(nextLine, baseUrl),
          checksum: null
        }
        
        if (currentVariant) currentVariant.segments.push(segment)
        if (currentTrack) currentTrack.segments.push(segment)
      }
    } else if (!line.startsWith('#') && currentVariant && !currentVariant.url) {
      currentVariant.url = this.resolveUrl(line, baseUrl)
      manifest.variants.push(currentVariant)
      currentVariant = null
    }
  }
  
  // Add current variant if exists
  if (currentVariant) {
    manifest.variants.push(currentVariant)
  }
  
  // Sort variants by bandwidth
  manifest.variants.sort((a, b) => a.bandwidth - b.bandwidth)
  
  return manifest
}

/**
 * Parse DASH manifest format (basic implementation)
 * @intuition Extract DASH manifest data
 * @approach XML parsing for DASH structure
 * @complexity Time: O(n) where n is XML nodes, Space: O(m) where m is representations
 */
parseDASHManifest(manifestData, baseUrl) {
  // Basic DASH parsing - can be extended for full DASH support
  const parser = new DOMParser()
  const doc = parser.parseFromString(manifestData, 'text/xml')
  
  const manifest = {
    type: 'dash',
    variants: [],
    audioTracks: [],
    subtitleTracks: [],
    baseUrl
  }
  
  // Extract video representations
  const videoAdaptationSets = doc.querySelectorAll('AdaptationSet[mimeType*="video"]')
  videoAdaptationSets.forEach((adaptationSet, setIndex) => {
    const representations = adaptationSet.querySelectorAll('Representation')
    representations.forEach((rep, repIndex) => {
      const bandwidth = parseInt(rep.getAttribute('bandwidth') || '0')
      const width = rep.getAttribute('width')
      const height = rep.getAttribute('height')
      const codecs = rep.getAttribute('codecs') || ''
      
      manifest.variants.push({
        id: `dash_video_${setIndex}_${repIndex}`,
        bandwidth,
        resolution: width && height ? `${width}x${height}` : null,
        codecs,
        segments: [] // DASH segment extraction would go here
      })
    })
  })
  
  // Extract audio representations
  const audioAdaptationSets = doc.querySelectorAll('AdaptationSet[mimeType*="audio"]')
  audioAdaptationSets.forEach((adaptationSet, setIndex) => {
    const lang = adaptationSet.getAttribute('lang') || 'unknown'
    const representations = adaptationSet.querySelectorAll('Representation')
    
    representations.forEach((rep, repIndex) => {
      manifest.audioTracks.push({
        id: `dash_audio_${setIndex}_${repIndex}`,
        type: 'audio',
        language: lang,
        name: `Audio ${lang}`,
        codec: rep.getAttribute('codecs') || '',
        segments: []
      })
    })
  })
  
  return manifest
}

/**
 * Extract available tracks from parsed manifest
 * @intuition Organize tracks by type for easy access
 * @approach Group tracks and set up default selections
 * @complexity Time: O(t) where t is total tracks, Space: O(t)
 */
extractAvailableTracks(manifest) {
  // Audio tracks
  if (manifest.audioTracks && manifest.audioTracks.length > 0) {
    this.availableTracks.set('audio', manifest.audioTracks)
    
    // Set default audio track
    const defaultAudio = manifest.audioTracks.find(track => track.default) || 
                         manifest.audioTracks[0]
    if (defaultAudio) {
      this.activeTracks.set('audio', defaultAudio.id)
    }
  }
  
  // Subtitle tracks
  if (manifest.subtitleTracks && manifest.subtitleTracks.length > 0) {
    this.availableTracks.set('subtitle', manifest.subtitleTracks)
    
    // Set default subtitle track if any
    const defaultSubtitle = manifest.subtitleTracks.find(track => track.default)
    if (defaultSubtitle) {
      this.activeTracks.set('subtitle', defaultSubtitle.id)
    }
  }
  
  // Video variants (quality levels)
  if (manifest.variants && manifest.variants.length > 0) {
    this.availableTracks.set('video', manifest.variants)
  }
}

/**
 * Extract base URL from manifest URL
 * @intuition Get base path for resolving relative URLs
 * @approach Parse URL and extract directory path
 * @complexity Time: O(1), Space: O(1)
 */
extractBaseUrl(manifestUrl) {
  try {
    const url = new URL(manifestUrl)
    const pathParts = url.pathname.split('/')
    pathParts.pop() // Remove manifest filename
    return `${url.protocol}//${url.host}${pathParts.join('/')}/`
  } catch (error) {
    console.warn('Failed to extract base URL:', error)
    return manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1)
  }
}

/**
 * Resolve relative URL against base URL
 * @intuition Convert relative URLs to absolute URLs
 * @approach Handle various URL formats correctly
 * @complexity Time: O(1), Space: O(1)
 */
resolveUrl(url, baseUrl) {
  if (!url) return null
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('/')) {
    const base = new URL(baseUrl)
    return `${base.protocol}//${base.host}${url}`
  }
  return `${baseUrl}${url}`
}

/**
 * Extract codec for specific track type
 * @intuition Get appropriate codec string for track type
 * @approach Parse codec string and match to track type
 * @complexity Time: O(1), Space: O(1)
 */
extractCodecForTrackType(trackType, codecs) {
  if (!codecs) return 'audio/mp4; codecs="mp4a.40.2"' // Default AAC
  
  const codecList = codecs.split(',').map(c => c.trim())
  
  if (trackType === 'AUDIO') {
    const audioCodec = codecList.find(c => 
      c.startsWith('mp4a.') || c.startsWith('opus') || c.startsWith('ac-3')
    )
    return audioCodec ? `audio/mp4; codecs="${audioCodec}"` : 'audio/mp4; codecs="mp4a.40.2"'
  }
  
  return 'audio/mp4; codecs="mp4a.40.2"'
}


  /**
   * Setup MediaSource source buffers for video and audio
   * @intuition Create separate buffers for video and audio streams
   * @approach Extract codecs and create buffers if supported
   * @complexity Time: O(1), Space: O(1)
   */
  async setupSourceBuffers() {
    const videoVariant = this.manifest.variants[0]
    const videoCodec = this.extractVideoCodec(videoVariant.codecs)
    const audioCodec = this.extractAudioCodec(videoVariant.codecs)
    
    if (videoCodec && MediaSource.isTypeSupported(`video/mp4; codecs="${videoCodec}"`)) {
      this.sourceBuffers.set('video', this.mediaSource.addSourceBuffer(`video/mp4; codecs="${videoCodec}"`))
    }
    
    if (audioCodec && MediaSource.isTypeSupported(`audio/mp4; codecs="${audioCodec}"`)) {
      this.sourceBuffers.set('audio', this.mediaSource.addSourceBuffer(`audio/mp4; codecs="${audioCodec}"`))
    }
    
    this.sourceBuffers.forEach((buffer, type) => {
      buffer.addEventListener('updateend', () => this.onSourceBufferUpdate(type))
      buffer.addEventListener('error', (error) => this.errorEvents$.next({ type: 'sourcebuffer', error }))
    })
  }

  /**
   * Start playback with initial segments
   * @intuition Begin playback flow with optimal bitrate selection
   * @approach Select bitrate, setup monitoring, start downloads and prefetching
   * @complexity Time: O(1), Space: O(1)
   */
  async startPlayback() {
    this.currentBitrate = this.selectInitialBitrate()
    const variant = this.manifest.variants.find(v => v.bandwidth === this.currentBitrate)
    
    this.setupPlaybackMonitoring()
    this.startSegmentDownloading(variant)
    this.startPrefetching()
    
    return this.loadInitialSegments(variant)
  }

  /**
   * Select optimal initial bitrate based on network conditions
   * @intuition Choose highest sustainable bitrate for current network
   * @approach Estimate bandwidth and apply threshold for stability
   * @complexity Time: O(n) where n is variants count, Space: O(1)
   */
  selectInitialBitrate() {
    const targetBandwidth = this.estimateAvailableBandwidth() * this.config.adaptiveBitrateThreshold
    
    return this.manifest.variants
      .filter(v => v.bandwidth <= targetBandwidth)
      .pop()?.bandwidth || this.manifest.variants[0].bandwidth
  }

  /**
   * Estimate available bandwidth using Navigator Connection API
   * @intuition Use browser's network info or fallback to measured bandwidth
   * @approach Check navigator.connection or use bandwidth estimator
   * @complexity Time: O(1), Space: O(1)
   */
  estimateAvailableBandwidth() {
    if (navigator.connection) {
      return navigator.connection.downlink * 1000000 * 0.8
    }
    return this.bandwidthEstimator.getCurrentBandwidth()
  }

  /**
   * Load initial segments for sub-200ms startup
   * @intuition Load initialization segment first for instant playback
   * @approach Download init segment, start playback, then background load media segments
   * @complexity Time: O(1) for init, O(k) for background where k is segments, Space: O(k)
   */
  async loadInitialSegments(variant) {
    // Load only the first segment for sub-200ms startup
    const initSegment = variant.segments[0]
    if (!initSegment) return Promise.resolve()
    
    try {
      // Download and append initialization segment
      await this.downloadAndAppendSegment(initSegment, 'video', 0)
      
      // Start playback immediately after init segment
      if (this.videoElement.readyState >= 2) {
        await this.videoElement.play()
        
        // Background load remaining initial segments
        this.loadBackgroundSegments(variant, 1, Math.min(3, variant.segments.length))
      } else {
        // Wait for ready state if needed
        return new Promise((resolve) => {
          const checkReady = () => {
            if (this.videoElement.readyState >= 2) {
              this.videoElement.play().then(resolve)
            } else {
              setTimeout(checkReady, 50)
            }
          }
          checkReady()
        })
      }
    } catch (error) {
      this.errorEvents$.next({ type: 'initialization', error })
      throw error
    }
  }

  /**
   * Load segments in background without blocking playback
   * @intuition Continue loading segments after playback has started
   * @approach Download segments asynchronously without waiting
   * @complexity Time: O(k) where k is segments count, Space: O(k)
   */
  async loadBackgroundSegments(variant, startIndex, endIndex) {
    const downloadPromises = []
    
    for (let i = startIndex; i < endIndex; i++) {
      if (i < variant.segments.length) {
        downloadPromises.push(
          this.downloadAndAppendSegment(variant.segments[i], 'video', i)
            .catch(error => {
              console.warn(`Background segment ${i} download failed:`, error)
            })
        )
      }
    }
    
    // Don't await - let these download in background
    Promise.all(downloadPromises).catch(error => {
      console.warn('Background segment loading failed:', error)
    })
  }

  /**
   * Start continuous segment downloading based on playback position
   * @intuition Maintain buffer ahead of playback position
   * @approach Use interval-based checking with RxJS operators
   * @complexity Time: O(1) per interval, Space: O(1)
   */
  startSegmentDownloading(variant) {
    this.segmentDownloadSubscription = interval(100)
      .pipe(
        map(() => this.calculateRequiredSegments()),
        distinctUntilChanged((prev, curr) => 
          prev.start === curr.start && prev.end === curr.end
        ),
        switchMap(range => this.downloadSegmentRange(variant, range)),
        takeUntil(this.destroy$)
      )
      .subscribe({
        next: () => {},
        error: (error) => this.errorEvents$.next({ type: 'download', error })
      })
  }

  /**
   * Calculate which segments are needed for current playback
   * @intuition Determine segment range based on buffer requirements
   * @approach Analyze current time, buffered ranges, and target buffer size
   * @complexity Time: O(b) where b is buffered ranges, Space: O(1)
   */
  calculateRequiredSegments() {
    const currentTime = this.videoElement.currentTime
    const buffered = this.videoElement.buffered
    const duration = this.videoElement.duration || 0
    
    let bufferedEnd = currentTime
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= currentTime && buffered.end(i) > currentTime) {
        bufferedEnd = buffered.end(i)
        break
      }
    }
    
    const bufferGap = this.config.bufferSize - (bufferedEnd - currentTime)
    const segmentDuration = this.getAverageSegmentDuration()
    
    const startSegment = Math.floor(currentTime / segmentDuration)
    const endSegment = Math.min(
      Math.ceil((currentTime + Math.max(bufferGap, 0)) / segmentDuration),
      Math.floor(duration / segmentDuration)
    )
    
    return { start: startSegment, end: endSegment }
  }

  /**
   * Download segments in specified range with concurrency control
   * @intuition Download multiple segments simultaneously with limits
   * @approach Filter uncached segments and convert to observables with concurrency limit
   * @complexity Time: O(n) where n is range size, Space: O(c) where c is concurrent downloads
   */
  downloadSegmentRange(variant, range) {
    const downloads = []
    
    for (let i = range.start; i <= range.end; i++) {
      if (i < variant.segments.length && !this.segmentCache.has(`${variant.bandwidth}_${i}`)) {
        downloads.push(
          from(this.downloadAndAppendSegment(variant.segments[i], 'video', i, variant.bandwidth))
        )
      }
    }
    
    return merge(...downloads.slice(0, this.config.maxConcurrentDownloads))
  }

  /**
   * Download and append segment to source buffer with caching
   * @intuition Handle segment downloading with cache optimization
   * @approach Check cache, manage download queue, validate and append
   * @complexity Time: O(1) cached, O(n) uncached where n is segment size, Space: O(s) where s is segment size
   */
  async downloadAndAppendSegment(segment, type, index, bitrate = this.currentBitrate) {
    const cacheKey = `${bitrate}_${index}`
    
    if (this.segmentCache.has(cacheKey)) {
      return this.appendSegmentToBuffer(this.segmentCache.get(cacheKey), type)
    }
    
    if (this.downloadQueue.has(cacheKey)) {
      return this.downloadQueue.get(cacheKey)
    }
    
    const downloadPromise = this.segmentDownloader.download(segment, this.manifest.cdnUrls)
      .then(data => {
        if (this.config.checksumValidation && segment.checksum) {
          this.validateSegmentChecksum(data, segment.checksum)
        }
        
        this.segmentCache.set(cacheKey, data)
        this.downloadQueue.delete(cacheKey)
        
        return this.appendSegmentToBuffer(data, type)
      })
      .catch(error => {
        this.downloadQueue.delete(cacheKey)
        this.errorEvents$.next({ type: 'segment_download', error, segment, index })
        throw error
      })
    
    this.downloadQueue.set(cacheKey, downloadPromise)
    return downloadPromise
  }

  /**
   * Append segment data to MediaSource buffer
   * @intuition Add segment data to appropriate source buffer
   * @approach Wait for buffer ready state and handle update events
   * @complexity Time: O(1), Space: O(1)
   */
  async appendSegmentToBuffer(data, type) {
    const buffer = this.sourceBuffers.get(type)
    if (!buffer || buffer.updating) {
      await this.waitForBufferReady(buffer)
    }
    
    return new Promise((resolve, reject) => {
      const onUpdateEnd = () => {
        buffer.removeEventListener('updateend', onUpdateEnd)
        buffer.removeEventListener('error', onError)
        resolve()
      }
      
      const onError = (error) => {
        buffer.removeEventListener('updateend', onUpdateEnd)
        buffer.removeEventListener('error', onError)
        reject(error)
      }
      
      buffer.addEventListener('updateend', onUpdateEnd)
      buffer.addEventListener('error', onError)
      
      try {
        buffer.appendBuffer(data)
      } catch (error) {
        buffer.removeEventListener('updateend', onUpdateEnd)
        buffer.removeEventListener('error', onError)
        reject(error)
      }
    })
  }

  /**
   * Wait for source buffer to be ready for operations
   * @intuition Ensure buffer is not updating before operations
   * @approach Poll buffer state with timeout
   * @complexity Time: O(t) where t is wait time, Space: O(1)
   */
  async waitForBufferReady(buffer) {
    if (!buffer.updating) return Promise.resolve()
    
    return new Promise((resolve) => {
      const checkReady = () => {
        if (!buffer.updating) {
          resolve()
        } else {
          setTimeout(checkReady, 10)
        }
      }
      checkReady()
    })
  }

  /**
   * Start intelligent segment prefetching
   * @intuition Preload upcoming segments for seamless playback
   * @approach Monitor playback state and prefetch ahead
   * @complexity Time: O(1) per state change, Space: O(p) where p is prefetch count
   */
  startPrefetching() {
    this.prefetchSubscription = this.playbackState$
      .pipe(
        debounceTime(500),
        map(state => this.calculatePrefetchSegments(state)),
        switchMap(segments => this.prefetchSegments(segments)),
        takeUntil(this.destroy$)
      )
      .subscribe({
        error: (error) => this.errorEvents$.next({ type: 'prefetch', error })
      })
  }

  /**
   * Calculate which segments to prefetch
   * @intuition Determine upcoming segments based on current position
   * @approach Calculate segment indices ahead of current position
   * @complexity Time: O(1), Space: O(p) where p is prefetch count
   */
  calculatePrefetchSegments(state) {
    const currentTime = state.position
    const segmentDuration = this.getAverageSegmentDuration()
    const currentSegment = Math.floor(currentTime / segmentDuration)
    
    const prefetchStart = currentSegment + 1
    const prefetchEnd = prefetchStart + this.config.prefetchSegments
    
    return Array.from({ length: prefetchEnd - prefetchStart }, (_, i) => prefetchStart + i)
  }

  /**
   * Prefetch segments with concurrency control
   * @intuition Download future segments to improve seeking performance
   * @approach Filter valid segments and download with limits
   * @complexity Time: O(n) where n is prefetch count, Space: O(c) where c is concurrent downloads
   */
  prefetchSegments(segmentIndexes) {
    const variant = this.manifest.variants.find(v => v.bandwidth === this.currentBitrate)
    if (!variant) return of([])
    
    const prefetchPromises = segmentIndexes
      .filter(index => index < variant.segments.length)
      .map(index => {
        const cacheKey = `${this.currentBitrate}_${index}`
        if (!this.segmentCache.has(cacheKey) && !this.downloadQueue.has(cacheKey)) {
          return this.downloadAndAppendSegment(variant.segments[index], 'video', index)
        }
        return Promise.resolve()
      })
    
    return Promise.all(prefetchPromises.slice(0, this.config.maxConcurrentDownloads))
  }

  /**
   * Setup playback position monitoring
   * @intuition Track video element events for state management
   * @approach Listen to time, seeking events and update state
   * @complexity Time: O(1) per event, Space: O(1)
   */
  setupPlaybackMonitoring() {
    const timeUpdate$ = fromEvent(this.videoElement, 'timeupdate')
    const seeking$ = fromEvent(this.videoElement, 'seeking')
    const seeked$ = fromEvent(this.videoElement, 'seeked')
    
    merge(timeUpdate$, seeking$, seeked$)
      .pipe(
        map(() => ({
          position: this.videoElement.currentTime,
          buffered: this.getBufferedRanges(),
          seeking: this.videoElement.seeking
        })),
        takeUntil(this.destroy$)
      )
      .subscribe(this.playbackState$)
  }

  /**
   * Get buffered time ranges from video element
   * @intuition Extract buffered ranges for buffer management
   * @approach Convert TimeRanges to array format
   * @complexity Time: O(r) where r is ranges count, Space: O(r)
   */
  getBufferedRanges() {
    const buffered = this.videoElement.buffered
    const ranges = []
    
    for (let i = 0; i < buffered.length; i++) {
      ranges.push({ start: buffered.start(i), end: buffered.end(i) })
    }
    
    return ranges
  }

  /**
   * Setup network condition monitoring
   * @intuition Monitor network changes for adaptive bitrate
   * @approach Listen to connection changes and bandwidth updates
   * @complexity Time: O(1) per event, Space: O(1)
   */
  setupNetworkMonitoring() {
    if (navigator.connection) {
      fromEvent(navigator.connection, 'change')
        .pipe(
          map(() => this.calculateNetworkQuality()),
          takeUntil(this.destroy$)
        )
        .subscribe(this.networkQuality$)
    }
    
    this.bandwidthEstimator.bandwidth$
      .pipe(
        map(() => this.calculateNetworkQuality()),
        takeUntil(this.destroy$)
      )
      .subscribe(this.networkQuality$)
  }

  /**
   * Setup error tracking for statistics
   * @intuition Track error counts and last error for monitoring
   * @approach Subscribe to error events and update counters
   * @complexity Time: O(1) per error, Space: O(1)
   */
  setupErrorTracking() {
    this.errorEvents$
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (errorEvent) => {
          this.errorCount++
          this.lastError = errorEvent
        }
      })
  }

  /**
   * Start playback state saving for resume functionality
   * @intuition Save playback position periodically for resume
   * @approach Subscribe to playback state and save to storage
   * @complexity Time: O(1) per save, Space: O(1)
   */
  startPlaybackStateSaving() {
    if (!this.contentId) return
    
    this.stateSaveSubscription = this.playbackState$
      .pipe(
        debounceTime(2000), // Save every 2 seconds
        filter(state => !state.seeking && state.position > 0),
        takeUntil(this.destroy$)
      )
      .subscribe({
        next: (state) => this.savePlaybackState(state)
      })
  }

  /**
   * Save current playback state to storage
   * @intuition Persist playback position for resume functionality
   * @approach Store position and timestamp in localStorage
   * @complexity Time: O(1), Space: O(1)
   */
  savePlaybackState(state = null) {
    if (!this.contentId) return
    
    const currentState = state || this.playbackState$.value
    const stateData = {
      position: currentState.position,
      timestamp: Date.now(),
      bitrate: this.currentBitrate,
      activeTracks: Object.fromEntries(this.activeTracks)
    }
    
    try {
      localStorage.setItem(`playback_state_${this.contentId}`, JSON.stringify(stateData))
    } catch (error) {
      console.warn('Failed to save playback state:', error)
    }
  }

  /**
   * Load saved playback state from storage
   * @intuition Restore previous playback position for resume
   * @approach Retrieve and validate saved state from localStorage
   * @complexity Time: O(1), Space: O(1)
   */
  loadPlaybackState() {
    if (!this.contentId) return null
    
    try {
      const savedState = localStorage.getItem(`playback_state_${this.contentId}`)
      if (!savedState) return null
      
      const stateData = JSON.parse(savedState)
      const maxAge = 24 * 60 * 60 * 1000 // 24 hours
      
      if (Date.now() - stateData.timestamp > maxAge) {
        localStorage.removeItem(`playback_state_${this.contentId}`)
        return null
      }
      
      return stateData
    } catch (error) {
      console.warn('Failed to load playback state:', error)
      return null
    }
  }

  /**
   * Resume playback from saved position
   * @intuition Start playback from previously saved position
   * @approach Load saved state and seek to position
   * @complexity Time: O(1), Space: O(1)
   */
  async resumeFromSavedState() {
    const savedState = this.loadPlaybackState()
    if (!savedState) return false
    
    try {
      await this.seek(savedState.position)
      
      // Restore bitrate if different
      if (savedState.bitrate && savedState.bitrate !== this.currentBitrate) {
        await this.switchBitrate(savedState.bitrate)
      }
      
      // Restore track selections
      if (savedState.activeTracks) {
        if (savedState.activeTracks.audio && this.availableTracks.has('audio')) {
          await this.switchAudioTrack(savedState.activeTracks.audio)
        }
        if (savedState.activeTracks.subtitle && this.availableTracks.has('subtitle')) {
          await this.switchSubtitleTrack(savedState.activeTracks.subtitle)
        }
      }
      
      return true
    } catch (error) {
      console.warn('Failed to resume from saved state:', error)
      return false
    }
  }

  /**
   * Calculate network quality score
   * @intuition Assess network conditions for bitrate decisions
   * @approach Combine connection type, RTT, and measured bandwidth
   * @complexity Time: O(1), Space: O(1)
   */
  calculateNetworkQuality() {
    let quality = 1.0
    
    if (navigator.connection) {
      const effectiveType = navigator.connection.effectiveType
      const rtt = navigator.connection.rtt || 0
      const downlink = navigator.connection.downlink || 0
      
      switch (effectiveType) {
        case 'slow-2g': quality = Math.min(quality, 0.2); break
        case '2g': quality = Math.min(quality, 0.4); break
        case '3g': quality = Math.min(quality, 0.6); break
        case '4g': quality = Math.min(quality, 1.0); break
      }
      
      if (rtt > 300) quality *= 0.8
      if (downlink < 1.5) quality *= 0.7
    }
    
    const currentBandwidth = this.bandwidthEstimator.getCurrentBandwidth()
    if (currentBandwidth < 1000000) quality *= 0.5
    else if (currentBandwidth < 5000000) quality *= 0.8
    
    return Math.max(0.1, quality)
  }

  /**
   * Setup adaptive bitrate switching
   * @intuition Automatically adjust quality based on conditions
   * @approach Monitor network and buffer states for optimal bitrate
   * @complexity Time: O(1) per event, Space: O(1)
   */
  setupAdaptiveBitrate() {
    // Add null check for manifest
    if (!this.manifest || !this.manifest.variants) {
      console.warn('Manifest not loaded, skipping adaptive bitrate setup')
      return
    }
    
    this.adaptiveBitrateSubscription = this.adaptiveBitrateController
      .getOptimalBitrate$(this.manifest.variants, this.playbackState$)
      .pipe(
        distinctUntilChanged(),
        filter(bitrate => bitrate !== this.currentBitrate),
        filter(() => this.adaptiveBitrateEnabled), // Respect manual override
        takeUntil(this.destroy$)
      )
      .subscribe({
        next: (bitrate) => this.switchBitrate(bitrate),
        error: (error) => this.errorEvents$.next({ type: 'adaptive_bitrate', error })
      })
  }

  /**
   * Switch to new bitrate variant
   * @intuition Change quality level while maintaining playback
   * @approach Preload segments from new variant for seamless transition
   * @complexity Time: O(k) where k is preload segments, Space: O(k)
   */
  async switchBitrate(newBitrate) {
    const oldBitrate = this.currentBitrate
    this.currentBitrate = newBitrate
    
    const newVariant = this.manifest.variants.find(v => v.bandwidth === newBitrate)
    if (!newVariant) return
    
    try {
      await this.seamlessBitrateSwitch(newVariant, oldBitrate)
    } catch (error) {
      this.currentBitrate = oldBitrate
      this.errorEvents$.next({ type: 'bitrate_switch', error })
    }
  }

  /**
   * Perform seamless bitrate switching
   * @intuition Switch quality without playback interruption
   * @approach Preload upcoming segments from new variant
   * @complexity Time: O(k) where k is preload count, Space: O(k)
   */
  async seamlessBitrateSwitch(newVariant, oldBitrate) {
    const currentTime = this.videoElement.currentTime
    const segmentDuration = this.getAverageSegmentDuration()
    const nextSegmentIndex = Math.ceil(currentTime / segmentDuration)
    
    const preloadPromises = []
    for (let i = 0; i < 3 && nextSegmentIndex + i < newVariant.segments.length; i++) {
      preloadPromises.push(
        this.downloadAndAppendSegment(
          newVariant.segments[nextSegmentIndex + i], 
          'video', 
          nextSegmentIndex + i, 
          newVariant.bandwidth
        )
      )
    }
    
    await Promise.all(preloadPromises)
  }

/**
 * Switch to different audio track with buffer management
 * @intuition Seamlessly change audio language during playback
 * @approach Clear audio buffer, create new source buffer, reload segments
 * @complexity Time: O(k) where k is buffer refill segments, Space: O(k)
 */
async switchAudioTrack(trackId) {
  if (!this.availableTracks.has('audio')) return false
  
  const audioTracks = this.availableTracks.get('audio')
  const targetTrack = audioTracks.find(track => track.id === trackId)
  
  if (!targetTrack) throw new Error(`Audio track ${trackId} not found`)
  
  // Don't switch if already active
  if (this.activeTracks.get('audio') === trackId) return true
  
  try {
    // Remove current audio source buffer
    if (this.sourceBuffers.has('audio')) {
      const audioBuffer = this.sourceBuffers.get('audio')
      await this.waitForBufferReady(audioBuffer)
      this.mediaSource.removeSourceBuffer(audioBuffer)
    }
    
    // Create new source buffer for target audio track
    const audioBuffer = this.mediaSource.addSourceBuffer(targetTrack.codec)
    this.sourceBuffers.set('audio', audioBuffer)
    this.activeTracks.set('audio', trackId)
    
    // Setup buffer event handlers
    audioBuffer.addEventListener('updateend', () => this.onSourceBufferUpdate('audio'))
    audioBuffer.addEventListener('error', (error) => this.errorEvents$.next({ type: 'sourcebuffer', error }))
    
    // Re-download current segments for new audio track
    await this.refillBufferForTrackSwitch('audio', targetTrack)
    
    return true
  } catch (error) {
    this.errorEvents$.next({ type: 'audio_track_switch', error })
    throw error
  }
}

/**
 * Enhanced subtitle track switching with WebVTT support
 * @intuition Change subtitle language with proper track management
 * @approach Load subtitle data and manage text tracks
 * @complexity Time: O(s) where s is subtitle file size, Space: O(c) where c is cues count
 */
async switchSubtitleTrack(trackId) {
  const subtitleTracks = this.availableTracks.get('subtitle') || []
  
  if (!trackId || trackId === 'off') {
    // Disable subtitles
    this.activeTracks.delete('subtitle')
    this.hideSubtitles()
    return true
  }
  
  const targetTrack = subtitleTracks.find(track => track.id === trackId)
  if (!targetTrack) throw new Error(`Subtitle track ${trackId} not found`)
  
  try {
    this.activeTracks.set('subtitle', trackId)
    await this.loadSubtitleTrack(targetTrack)
    return true
  } catch (error) {
    this.errorEvents$.next({ type: 'subtitle_track_switch', error })
    throw error
  }
}

/**
 * Refill buffer after track switch
 * @intuition Reload segments for new track to maintain playback
 * @approach Calculate current position and reload buffer segments
 * @complexity Time: O(k) where k is buffer segments, Space: O(k)
 */
async refillBufferForTrackSwitch(type, track) {
  const currentTime = this.videoElement.currentTime
  const segmentDuration = this.getAverageSegmentDuration()
  const currentSegment = Math.floor(currentTime / segmentDuration)
  const bufferSegments = Math.min(5, track.segments.length - currentSegment)
  
  const downloadPromises = []
  for (let i = 0; i < bufferSegments && currentSegment + i < track.segments.length; i++) {
    const segmentIndex = currentSegment + i
    downloadPromises.push(
      this.downloadAndAppendSegment(
        track.segments[segmentIndex],
        type,
        segmentIndex,
        track.bandwidth || this.currentBitrate
      )
    )
  }
  
  await Promise.all(downloadPromises)
}

/**
 * Load subtitle track with format detection
 * @intuition Load and parse subtitle files with multiple format support
 * @approach Detect format and parse appropriately
 * @complexity Time: O(c) where c is cues count, Space: O(c)
 */
async loadSubtitleTrack(track) {
  if (!track.uri) return
  
  try {
    const response = await axios.get(track.uri, { timeout: this.config.segmentTimeout })
    const subtitleData = response.data
    
    // Clear existing text tracks
    this.clearExistingTextTracks()
    
    // Create new text track
    const textTrack = this.videoElement.addTextTrack('subtitles', track.name, track.language)
    
    // Parse based on format
    let cues = []
    if (subtitleData.includes('WEBVTT')) {
      cues = this.parseWebVTT(subtitleData)
    } else if (subtitleData.includes('[Script Info]')) {
      cues = this.parseASS(subtitleData)
    } else {
      cues = this.parseSRT(subtitleData)
    }
    
    // Add cues to track
    cues.forEach(cue => {
      try {
        textTrack.addCue(cue)
      } catch (error) {
        console.warn('Failed to add cue:', error)
      }
    })
    
    textTrack.mode = 'showing'
  } catch (error) {
    this.errorEvents$.next({ type: 'subtitle_load', error })
    throw error
  }
}

/**
 * Hide all subtitle tracks
 * @intuition Disable subtitle display
 * @approach Set all text tracks to hidden mode
 * @complexity Time: O(t) where t is text tracks count, Space: O(1)
 */
hideSubtitles() {
  const textTracks = this.videoElement.textTracks
  for (let i = 0; i < textTracks.length; i++) {
    textTracks[i].mode = 'hidden'
  }
}

/**
 * Clear existing text tracks
 * @intuition Remove all current subtitle tracks
 * @approach Iterate and remove text tracks
 * @complexity Time: O(t) where t is text tracks count, Space: O(1)
 */
clearExistingTextTracks() {
  const textTracks = this.videoElement.textTracks
  while (textTracks.length > 0) {
    try {
      this.videoElement.removeChild(textTracks[0])
    } catch (error) {
      // Text tracks can't be removed in some browsers, just hide them
      textTracks[0].mode = 'hidden'
      break
    }
  }
}

/**
 * Parse SRT subtitle format
 * @intuition Convert SRT format to VTTCue objects
 * @approach Parse SRT blocks with timing and text
 * @complexity Time: O(n) where n is subtitle blocks, Space: O(c) where c is cues count
 */
parseSRT(srtData) {
  const cues = []
  const blocks = srtData.trim().split(/\n\s*\n/)
  
  for (const block of blocks) {
    const lines = block.split('\n')
    if (lines.length < 3) continue
    
    const timeLine = lines[1]
    const textLines = lines.slice(2)
    
    const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/)
    if (!timeMatch) continue
    
    const startTime = this.parseSRTTime(timeMatch[1])
    const endTime = this.parseSRTTime(timeMatch[2])
    const text = textLines.join('\n')
    
    try {
      cues.push(new VTTCue(startTime, endTime, text))
    } catch (error) {
      console.warn('Failed to create VTTCue:', error)
    }
  }
  
  return cues
}

/**
 * Parse SRT time format to seconds
 * @intuition Convert SRT time format (HH:MM:SS,mmm) to seconds
 * @approach Split time components and calculate total seconds
 * @complexity Time: O(1), Space: O(1)
 */
parseSRTTime(timeStr) {
  const [time, ms] = timeStr.split(',')
  const [hours, minutes, seconds] = time.split(':').map(Number)
  return hours * 3600 + minutes * 60 + seconds + Number(ms) / 1000
}

/**
 * Parse ASS subtitle format (basic support)
 * @intuition Convert ASS format to VTTCue objects
 * @approach Extract dialogue lines and convert timing
 * @complexity Time: O(n) where n is dialogue lines, Space: O(c) where c is cues count
 */
parseASS(assData) {
  const cues = []
  const lines = assData.split('\n')
  
  for (const line of lines) {
    if (!line.startsWith('Dialogue:')) continue
    
    const parts = line.split(',')
    if (parts.length < 10) continue
    
    const startTime = this.parseASSTime(parts[1])
    const endTime = this.parseASSTime(parts[2])
    const text = parts.slice(9).join(',').replace(/\\N/g, '\n')
    
    try {
      cues.push(new VTTCue(startTime, endTime, text))
    } catch (error) {
      console.warn('Failed to create VTTCue:', error)
    }
  }
  
  return cues
}

/**
 * Parse ASS time format to seconds
 * @intuition Convert ASS time format (H:MM:SS.cc) to seconds
 * @approach Parse time components with centiseconds
 * @complexity Time: O(1), Space: O(1)
 */
parseASSTime(timeStr) {
  const [hours, minutes, seconds] = timeStr.split(':').map(Number)
  return hours * 3600 + minutes * 60 + seconds
}


  /**
   * Load subtitle data into video text track
   * @intuition Add subtitles to video element for display
   * @approach Parse WebVTT and create text track with cues
   * @complexity Time: O(c) where c is cues count, Space: O(c)
   */
  loadSubtitles(subtitleData) {
    const textTrack = this.videoElement.addTextTrack('subtitles', this.activeTracks.get('subtitle').name)
    const cues = this.parseWebVTT(subtitleData)
    
    cues.forEach(cue => textTrack.addCue(cue))
    textTrack.mode = 'showing'
  }

  /**
   * Parse WebVTT subtitle format
   * @intuition Convert WebVTT text to VTTCue objects
   * @approach Parse timecodes and text content
   * @complexity Time: O(n) where n is lines count, Space: O(c) where c is cues count
   */
  parseWebVTT(vttData) {
    const lines = vttData.split('\n')
    const cues = []
    let currentCue = null
    
    for (const line of lines) {
      if (line.includes('-->')) {
        const [start, end] = line.split(' --> ')
        currentCue = new VTTCue(
          this.parseTimeString(start.trim()),
          this.parseTimeString(end.trim()),
          ''
        )
      } else if (currentCue && line.trim() && !line.startsWith('WEBVTT')) {
        currentCue.text = line.trim()
        cues.push(currentCue)
        currentCue = null
      }
    }
    
    return cues
  }

  /**
   * Parse time string to seconds
   * @intuition Convert HH:MM:SS.mmm format to seconds
   * @approach Split by colons and calculate total seconds
   * @complexity Time: O(1), Space: O(1)
   */
  parseTimeString(timeStr) {
    const parts = timeStr.split(':')
    const seconds = parseFloat(parts.pop())
    const minutes = parseInt(parts.pop() || '0')
    const hours = parseInt(parts.pop() || '0')
    
    return hours * 3600 + minutes * 60 + seconds
  }

  /**
   * Seek to specific time position
   * @intuition Jump to time with minimal buffering delay
   * @approach Load target segment if not cached, then seek
   * @complexity Time: O(1) cached, O(s) uncached where s is segment size, Space: O(1)
   */
  async seek(time) {
    this.playbackState$.next({ 
      ...this.playbackState$.value, 
      seeking: true, 
      position: time 
    })
    
    const segmentDuration = this.getAverageSegmentDuration()
    const targetSegment = Math.floor(time / segmentDuration)
    const variant = this.manifest.variants.find(v => v.bandwidth === this.currentBitrate)
    
    if (targetSegment < variant.segments.length) {
      const cacheKey = `${this.currentBitrate}_${targetSegment}`
      
      if (this.segmentCache.has(cacheKey)) {
        this.videoElement.currentTime = time
        return Promise.resolve()
      }
      
      try {
        await this.downloadAndAppendSegment(
          variant.segments[targetSegment], 
          'video', 
          targetSegment
        )
        this.videoElement.currentTime = time
      } catch (error) {
        this.errorEvents$.next({ type: 'seek', error })
        throw error
      }
    }
  }

  /**
   * Resume playback after interruption
   * @intuition Restart playback from current position
   * @approach Reload initial segments and restore playback
   * @complexity Time: O(k) where k is initial segments, Space: O(k)
   */
  async resumePlayback() {
    const currentTime = this.videoElement.currentTime
    const variant = this.manifest.variants.find(v => v.bandwidth === this.currentBitrate)
    
    try {
      await this.loadInitialSegments(variant)
      this.videoElement.currentTime = currentTime
      await this.videoElement.play()
    } catch (error) {
      this.errorEvents$.next({ type: 'resume', error })
      throw error
    }
  }

  /**
   * Validate segment integrity using checksum
   * @intuition Ensure segment data integrity
   * @approach Calculate SHA-256 hash and compare with expected
   * @complexity Time: O(s) where s is segment size, Space: O(1)
   */
  validateSegmentChecksum(data, expectedChecksum) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const arrayBuffer = reader.result
        crypto.subtle.digest('SHA-256', arrayBuffer).then(hashBuffer => {
          const hashArray = Array.from(new Uint8Array(hashBuffer))
          const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
          
          if (hashHex === expectedChecksum) {
            resolve()
          } else {
            reject(new Error('Segment checksum validation failed'))
          }
        })
      }
      reader.readAsArrayBuffer(new Blob([data]))
    })
  }

  /**
   * Calculate average segment duration
   * @intuition Estimate typical segment length for calculations
   * @approach Average duration from first variant segments
   * @complexity Time: O(n) where n is segments count, Space: O(1)
   */
  getAverageSegmentDuration() {
    if (!this.manifest || !this.manifest.variants.length) return 10
    
    const firstVariant = this.manifest.variants[0]
    if (!firstVariant.segments.length) return 10
    
    const totalDuration = firstVariant.segments.reduce((sum, seg) => sum + seg.duration, 0)
    return totalDuration / firstVariant.segments.length
  }

  /**
   * Extract video codec from codecs string
   * @intuition Parse video codec identifier
   * @approach Find video codec patterns in codec string
   * @complexity Time: O(n) where n is codecs count, Space: O(1)
   */
  extractVideoCodec(codecs) {
    if (!codecs) return null
    const videoCodecs = codecs.split(',').map(c => c.trim())
    return videoCodecs.find(c => c.startsWith('avc1.') || c.startsWith('hev1.') || c.startsWith('vp09.'))
  }

  /**
   * Extract audio codec from codecs string
   * @intuition Parse audio codec identifier
   * @approach Find audio codec patterns in codec string
   * @complexity Time: O(n) where n is codecs count, Space: O(1)
   */
  extractAudioCodec(codecs) {
    if (!codecs) return null
    const audioCodecs = codecs.split(',').map(c => c.trim())
    return audioCodecs.find(c => c.startsWith('mp4a.') || c.startsWith('opus'))
  }

  /**
   * Handle source buffer update events
   * @intuition Manage buffer cleanup after updates
   * @approach Clean old segments when buffer updates
   * @complexity Time: O(1), Space: O(1)
   */
  onSourceBufferUpdate(type) {
    const buffer = this.sourceBuffers.get(type)
    if (buffer.buffered.length > 0) {
      this.cleanupOldSegments(buffer)
    }
  }

  /**
   * Clean up old buffered segments
   * @intuition Remove old data to prevent memory issues
   * @approach Remove segments outside buffer window
   * @complexity Time: O(1), Space: O(1)
   */
  cleanupOldSegments(buffer) {
    const currentTime = this.videoElement.currentTime
    const bufferSize = this.config.bufferSize
    
    if (buffer.buffered.length > 0) {
      const start = buffer.buffered.start(0)
      const cleanupTime = Math.max(0, currentTime - bufferSize)
      
      if (start < cleanupTime) {
        try {
          buffer.remove(start, cleanupTime)
        } catch (error) {
          console.warn('Buffer cleanup failed:', error)
        }
      }
    }
  }

  /**
   * Utility delay function
   * @intuition Simple promise-based delay
   * @approach Return promise that resolves after timeout
   * @complexity Time: O(1), Space: O(1)
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

/**
 * Enhanced buffer management and playback statistics
 * @intuition Provide comprehensive playback information
 * @approach Collect metrics from various player components
 * @complexity Time: O(1), Space: O(1)
 */
getPlaybackStats() {
  const bufferedRanges = this.getBufferedRanges()
  const networkQuality = this.networkQuality$.value
  
  return {
    // Basic playback info
    currentTime: this.videoElement.currentTime,
    duration: this.videoElement.duration || 0,
    bufferedRanges,
    
    // Quality and performance
    currentBitrate: this.currentBitrate,
    networkQuality,
    averageBandwidth: this.bandwidthEstimator.getCurrentBandwidth(),
    
    // Cache and downloads
    cacheSize: this.segmentCache.size,
    activeDownloads: this.downloadQueue.size,
    
    // Track information
    activeTracks: Object.fromEntries(this.activeTracks),
    availableTracks: {
      audio: this.availableTracks.get('audio')?.length || 0,
      subtitle: this.availableTracks.get('subtitle')?.length || 0,
      video: this.availableTracks.get('video')?.length || 0
    },
    
    // Buffer health
    bufferHealth: this.calculateBufferHealth(),
    
    // Error tracking
    totalErrors: this.errorCount || 0,
    lastError: this.lastError || null
  }
}

/**
 * Calculate buffer health score
 * @intuition Assess buffer state for performance monitoring
 * @approach Analyze buffer level vs target for health score
 * @complexity Time: O(r) where r is buffered ranges, Space: O(1)
 */
calculateBufferHealth() {
  const currentTime = this.videoElement.currentTime
  const buffered = this.videoElement.buffered
  let bufferAhead = 0
  
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime && buffered.end(i) > currentTime) {
      bufferAhead = buffered.end(i) - currentTime
      break
    }
  }
  
  const targetBuffer = this.config.bufferSize
  const healthScore = Math.min(1.0, bufferAhead / targetBuffer)
  
  return {
    score: healthScore,
    bufferAhead,
    targetBuffer,
    status: healthScore > 0.8 ? 'excellent' : healthScore > 0.5 ? 'good' : healthScore > 0.2 ? 'fair' : 'poor'
  }
}

/**
 * Get available quality levels
 * @intuition Provide quality options for UI integration
 * @approach Format variant information for display
 * @complexity Time: O(v) where v is variants count, Space: O(v)
 */
getAvailableQualityLevels() {
  if (!this.currentManifest || !this.currentManifest.variants) return []
  
  return this.currentManifest.variants.map(variant => ({
    id: variant.id || `${variant.bandwidth}`,
    bandwidth: variant.bandwidth,
    resolution: variant.resolution,
    label: this.formatQualityLabel(variant),
    active: variant.bandwidth === this.currentBitrate
  }))
}

/**
 * Format quality label for display
 * @intuition Create user-friendly quality labels
 * @approach Combine resolution and bandwidth info
 * @complexity Time: O(1), Space: O(1)
 */
formatQualityLabel(variant) {
  if (variant.resolution) {
    const height = variant.resolution.split('x')[1]
    return `${height}p (${Math.round(variant.bandwidth / 1000)} kbps)`
  }
  return `${Math.round(variant.bandwidth / 1000)} kbps`
}

/**
 * Get available audio tracks for UI
 * @intuition Provide audio track options for selection
 * @approach Format audio track information
 * @complexity Time: O(a) where a is audio tracks count, Space: O(a)
 */
getAvailableAudioTracks() {
  const audioTracks = this.availableTracks.get('audio') || []
  return audioTracks.map(track => ({
    id: track.id,
    name: track.name || `Audio ${track.language}`,
    language: track.language,
    active: this.activeTracks.get('audio') === track.id
  }))
}

/**
 * Get available subtitle tracks for UI
 * @intuition Provide subtitle track options for selection
 * @approach Format subtitle track information with off option
 * @complexity Time: O(s) where s is subtitle tracks count, Space: O(s)
 */
getAvailableSubtitleTracks() {
  const subtitleTracks = this.availableTracks.get('subtitle') || []
  const tracks = [
    { id: 'off', name: 'Off', language: null, active: !this.activeTracks.has('subtitle') }
  ]
  
  tracks.push(...subtitleTracks.map(track => ({
    id: track.id,
    name: track.name || `Subtitles ${track.language}`,
    language: track.language,
    active: this.activeTracks.get('subtitle') === track.id
  })))
  
  return tracks
}

  /**
   * Manual quality level selection
   * @intuition Allow manual override of adaptive bitrate
   * @approach Disable auto-adaptation and set specific bitrate
   * @complexity Time: O(1), Space: O(1)
   */
  async setQualityLevel(levelId) {
    const variant = this.currentManifest?.variants.find(v => 
      (v.id || `${v.bandwidth}`) === levelId
    )
    
    if (!variant) throw new Error(`Quality level ${levelId} not found`)
    
    // Disable adaptive bitrate temporarily
    this.adaptiveBitrateEnabled = false
    
    try {
      await this.switchBitrate(variant.bandwidth)
      
      // Re-enable adaptive bitrate after 30 seconds
      setTimeout(() => {
        this.adaptiveBitrateEnabled = true
      }, 30000)
      
      return true
    } catch (error) {
      this.adaptiveBitrateEnabled = true
      throw error
    }
  }

  /**
   * Set content ID for state saving
   * @intuition Enable resume functionality with content identifier
   * @approach Set content ID and start state saving
   * @complexity Time: O(1), Space: O(1)
   */
  setContentId(contentId) {
    this.contentId = contentId
    this.startPlaybackStateSaving()
  }


  /**
   * Clean up resources and subscriptions
   * @intuition Properly dispose of all resources
   * @approach Cancel subscriptions, clear caches, close MediaSource
   * @complexity Time: O(1), Space: O(1)
   */
  destroy() {
    this.destroy$.next()
    this.destroy$.complete()

    
    
    if (this.segmentDownloadSubscription) {
      this.segmentDownloadSubscription.unsubscribe()
    }
    
    if (this.prefetchSubscription) {
      this.prefetchSubscription.unsubscribe()
    }
    
    if (this.adaptiveBitrateSubscription) {
      this.adaptiveBitrateSubscription.unsubscribe()
    }
    
    this.segmentCache.clear()
    this.downloadQueue.clear()
    
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      this.mediaSource.endOfStream()
    }

    // Add these lines to the existing destroy method
    if (this.stateSaveSubscription) {
      this.stateSaveSubscription.unsubscribe()
    }

    // Save final state before cleanup
    if (this.contentId) {
      this.savePlaybackState()
    }
    
    this.sourceBuffers.clear()
  }
}

/**
 * Bandwidth estimation for adaptive bitrate decisions
 * @intuition Track download performance to estimate available bandwidth
 * @approach Rolling average of recent measurements
 * @complexity Time: O(1) per measurement, Space: O(k) where k is measurement history
 */
class BandwidthEstimator {
  constructor() {
    this.measurements = []
    this.bandwidth$ = new Subject()
    this.currentBandwidth = 5000000 // Default 5 Mbps
  }

  /**
   * Add bandwidth measurement
   * @intuition Record download performance data
   * @approach Calculate bits per second and update rolling average
   * @complexity Time: O(1), Space: O(1)
   */
  addMeasurement(bytes, duration) {
    const bandwidth = (bytes * 8) / (duration / 1000)
    this.measurements.push({ bandwidth, timestamp: Date.now() })
    
    if (this.measurements.length > 10) {
      this.measurements.shift()
    }
    
    this.currentBandwidth = this.calculateAverageBandwidth()
    this.bandwidth$.next(this.currentBandwidth)
  }

  /**
   * Calculate average bandwidth from recent measurements
   * @intuition Get stable bandwidth estimate from recent data
   * @approach Average last 5 measurements
   * @complexity Time: O(k) where k is recent measurements, Space: O(1)
   */
  calculateAverageBandwidth() {
    if (this.measurements.length === 0) return this.currentBandwidth
    
    const recent = this.measurements.slice(-5)
    const sum = recent.reduce((acc, m) => acc + m.bandwidth, 0)
    return sum / recent.length
  }

  /**
   * Get current bandwidth estimate
   * @intuition Return latest bandwidth calculation
   * @approach Simple getter for current value
   * @complexity Time: O(1), Space: O(1)
   */
  getCurrentBandwidth() {
    return this.currentBandwidth
  }
}

/**
 * Segment downloader with CDN failover and retry logic
 * @intuition Handle robust segment downloading with error recovery
 * @approach Try multiple CDNs with exponential backoff retry
 * @complexity Time: O(r*c) where r is retries and c is CDN count, Space: O(s) where s is segment size
 */
class SegmentDownloader {
  constructor(config, bandwidthEstimator) {
    this.config = config
    this.bandwidthEstimator = bandwidthEstimator
  }

  /**
   * Download segment with failover and retry
   * @intuition Robust download with multiple recovery strategies
   * @approach Try each CDN with retries and exponential backoff
   * @complexity Time: O(r*c) where r is retries and c is CDN count, Space: O(s) where s is segment size
   */
  async download(segment, cdnUrls) {
    let lastError = null
    
    for (let cdnIndex = 0; cdnIndex < cdnUrls.length; cdnIndex++) {
      for (let retry = 0; retry < this.config.maxRetries; retry++) {
        try {
          const startTime = Date.now()
          const url = this.buildSegmentUrl(cdnUrls[cdnIndex], segment.url)
          
          const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: this.config.segmentTimeout,
            headers: {
              'Range': 'bytes=0-'
            }
          })
          
          const duration = Date.now() - startTime
          this.bandwidthEstimator.addMeasurement(response.data.byteLength, duration)
          
          return response.data
        } catch (error) {
          lastError = error
          if (retry < this.config.maxRetries - 1) {
            await this.delay(Math.pow(2, retry) * 1000)
          }
        }
      }
    }
    
    throw lastError
  }

  /**
   * Build complete segment URL from base and path
   * @intuition Construct proper URL for segment download
   * @approach Handle absolute and relative URLs correctly
   * @complexity Time: O(1), Space: O(1)
   */
  buildSegmentUrl(baseUrl, segmentPath) {
    if (segmentPath.startsWith('http')) return segmentPath
    
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    const path = segmentPath.startsWith('/') ? segmentPath : `/${segmentPath}`
    
    return `${base}${path}`
  }

  /**
   * Utility delay function
   * @intuition Promise-based delay for retry backoff
   * @approach Simple timeout wrapper
   * @complexity Time: O(1), Space: O(1)
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

/**
 * Adaptive bitrate controller for quality optimization
 * @intuition Automatically adjust video quality based on conditions
 * @approach Monitor network and buffer state for optimal bitrate selection
 * @complexity Time: O(v) where v is variants count, Space: O(1)
 */
class AdaptiveBitrateController {
  constructor(config, networkQuality$) {
    this.config = config
    this.networkQuality$ = networkQuality$
  }

  /**
   * Get optimal bitrate stream based on conditions
   * @intuition Reactive stream of optimal bitrate decisions
   * @approach Combine network quality and buffer state changes
   * @complexity Time: O(1) per event, Space: O(1)
   */
  getOptimalBitrate$(variants, playbackState$) {
    return merge(
      this.networkQuality$.pipe(debounceTime(1000)),
      playbackState$.pipe(
        map(state => state.buffered),
        distinctUntilChanged(),
        debounceTime(2000)
      )
    ).pipe(
      switchMap(() => this.calculateOptimalBitrate(variants)),
      distinctUntilChanged()
    )
  }

  /**
   * Calculate optimal bitrate for current conditions
   * @intuition Select best quality that network can sustain
   * @approach Apply network quality and threshold to available bandwidth
   * @complexity Time: O(v) where v is variants count, Space: O(1)
   */
  calculateOptimalBitrate(variants) {
    return new Promise((resolve) => {
      const networkQuality = this.networkQuality$.value
      const availableBandwidth = this.estimateAvailableBandwidth() * networkQuality
      const targetBandwidth = availableBandwidth * this.config.adaptiveBitrateThreshold
      
      const optimalVariant = variants
        .filter(v => v.bandwidth <= targetBandwidth)
        .pop() || variants[0]
      
      resolve(optimalVariant.bandwidth)
    })
  }

  /**
   * Estimate available bandwidth
   * @intuition Get network capacity estimate
   * @approach Use Navigator Connection API or fallback
   * @complexity Time: O(1), Space: O(1)
   */
  estimateAvailableBandwidth() {
    if (navigator.connection && navigator.connection.downlink) {
      return navigator.connection.downlink * 1000000
    }
    return 5000000 // Default 5 Mbps
  }
}

export { BandwidthEstimator, SegmentDownloader, AdaptiveBitrateController }
export default AdvancedStreamingPlayer
