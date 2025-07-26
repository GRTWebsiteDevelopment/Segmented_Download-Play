import { fromEvent, Subject, BehaviorSubject, merge, interval, of, EMPTY } from 'rxjs'
import { map, filter, switchMap, retry, catchError, debounceTime, distinctUntilChanged, shareReplay, takeUntil, bufferTime, mergeMap, concatMap } from 'rxjs/operators'
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
    
    this.networkQuality$ = new BehaviorSubject(1.0)
    this.playbackState$ = new BehaviorSubject({ position: 0, buffered: [], seeking: false })
    this.errorEvents$ = new Subject()
    this.destroy$ = new Subject()

    this.bandwidthEstimator = new BandwidthEstimator()
    this.segmentDownloader = new SegmentDownloader(this.config, this.bandwidthEstimator)
    this.adaptiveBitrateController = new AdaptiveBitrateController(this.config, this.networkQuality$)
    
    this.setupNetworkMonitoring()
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
   * Load HLS manifest with CDN failover support
   * @intuition Try multiple CDN endpoints for reliability
   * @approach Iterate through CDN URLs with exponential backoff
   * @complexity Time: O(n) where n is CDN count, Space: O(1)
   */
  async loadManifest(url) {
    const cdnUrls = Array.isArray(url) ? url : [url]
    
    for (let i = 0; i < cdnUrls.length; i++) {
      try {
        const response = await axios.get(cdnUrls[i], { timeout: this.config.segmentTimeout })
        const manifest = this.parseManifest(response.data)
        manifest.cdnIndex = i
        manifest.cdnUrls = cdnUrls
        return manifest
      } catch (error) {
        if (i === cdnUrls.length - 1) throw error
        await this.delay(this.config.cdnFailoverDelay)
      }
    }
  }

  /**
   * Parse HLS manifest data into structured format
   * @intuition Extract variants, tracks, and segments from HLS format
   * @approach Line-by-line parsing with state machine approach
   * @complexity Time: O(n) where n is manifest lines, Space: O(m) where m is variants count
   */
  parseManifest(manifestData) {
    const lines = manifestData.split('\n').filter(line => line.trim())
    const manifest = { 
      variants: [], 
      audioTracks: [], 
      subtitleTracks: [],
      segments: new Map()
    }
    
    let currentVariant = null
    let currentTrack = null
    
    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const bandwidth = parseInt(line.match(/BANDWIDTH=(\d+)/)?.[1] || '0')
        const resolution = line.match(/RESOLUTION=(\d+x\d+)/)?.[1]
        const codecs = line.match(/CODECS="([^"]+)"/)?.[1]
        
        currentVariant = { bandwidth, resolution, codecs, segments: [] }
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const type = line.match(/TYPE=(\w+)/)?.[1]
        const groupId = line.match(/GROUP-ID="([^"]+)"/)?.[1]
        const name = line.match(/NAME="([^"]+)"/)?.[1]
        const language = line.match(/LANGUAGE="([^"]+)"/)?.[1]
        const uri = line.match(/URI="([^"]+)"/)?.[1]
        
        currentTrack = { type, groupId, name, language, uri, segments: [] }
        
        if (type === 'AUDIO') manifest.audioTracks.push(currentTrack)
        else if (type === 'SUBTITLES') manifest.subtitleTracks.push(currentTrack)
      } else if (line.startsWith('#EXTINF:')) {
        const duration = parseFloat(line.match(/#EXTINF:([\d.]+)/)?.[1] || '0')
        const nextLine = lines[lines.indexOf(line) + 1]
        
        if (nextLine && !nextLine.startsWith('#')) {
          const segment = { duration, url: nextLine, checksum: null }
          
          if (currentVariant) currentVariant.segments.push(segment)
          if (currentTrack) currentTrack.segments.push(segment)
        }
      } else if (!line.startsWith('#') && currentVariant) {
        manifest.variants.push(currentVariant)
        currentVariant = null
      }
    }
    
    if (currentVariant) manifest.variants.push(currentVariant)
    
    manifest.variants.sort((a, b) => a.bandwidth - b.bandwidth)
    return manifest
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
    const networkQuality = this.networkQuality$.value
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
   * Load initial segments for playback start
   * @intuition Preload first few segments for instant playback
   * @approach Download first 3 segments in parallel
   * @complexity Time: O(k) where k is initial segments, Space: O(k)
   */
  async loadInitialSegments(variant) {
    const segmentsToLoad = Math.min(3, variant.segments.length)
    const downloadPromises = []
    
    for (let i = 0; i < segmentsToLoad; i++) {
      const segment = variant.segments[i]
      downloadPromises.push(this.downloadAndAppendSegment(segment, 'video', i))
    }
    
    await Promise.all(downloadPromises)
    
    if (this.videoElement.readyState >= 3) {
      return Promise.resolve()
    }
    
    return new Promise((resolve) => {
      const checkReady = () => {
        if (this.videoElement.readyState >= 3) {
          resolve()
        } else {
          setTimeout(checkReady, 50)
        }
      }
      checkReady()
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
   * @approach Filter uncached segments and merge with concurrency limit
   * @complexity Time: O(n) where n is range size, Space: O(c) where c is concurrent downloads
   */
  downloadSegmentRange(variant, range) {
    const downloads = []
    
    for (let i = range.start; i <= range.end; i++) {
      if (i < variant.segments.length && !this.segmentCache.has(`${variant.bandwidth}_${i}`)) {
        downloads.push(
          this.downloadAndAppendSegment(variant.segments[i], 'video', i, variant.bandwidth)
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
   * Switch to different audio track
   * @intuition Change audio language/quality during playback
   * @approach Clear audio buffer and load new track segments
   * @complexity Time: O(k) where k is initial segments, Space: O(k)
   */
  async switchAudioTrack(trackId) {
    const track = this.manifest.audioTracks.find(t => t.groupId === trackId)
    if (!track || this.activeTracks.get('audio') === track) return
    
    this.activeTracks.set('audio', track)
    
    const audioBuffer = this.sourceBuffers.get('audio')
    if (audioBuffer) {
      await this.waitForBufferReady(audioBuffer)
      audioBuffer.remove(0, audioBuffer.buffered.end(audioBuffer.buffered.length - 1))
      
      const currentTime = this.videoElement.currentTime
      const segmentDuration = this.getAverageSegmentDuration()
      const segmentIndex = Math.floor(currentTime / segmentDuration)
      
      for (let i = 0; i < 3 && segmentIndex + i < track.segments.length; i++) {
        await this.downloadAndAppendSegment(
          track.segments[segmentIndex + i], 
          'audio', 
          segmentIndex + i
        )
      }
    }
  }

  /**
   * Switch to different subtitle track
   * @intuition Change subtitle language during playback
   * @approach Load subtitle file and add text track
   * @complexity Time: O(s) where s is subtitle file size, Space: O(c) where c is cues count
   */
  async switchSubtitleTrack(trackId) {
    const track = this.manifest.subtitleTracks.find(t => t.groupId === trackId)
    if (!track) return
    
    this.activeTracks.set('subtitle', track)
    
    if (track.uri) {
      try {
        const response = await axios.get(track.uri)
        this.loadSubtitles(response.data)
      } catch (error) {
        this.errorEvents$.next({ type: 'subtitle_load', error })
      }
    }
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
   * Get current playback statistics
   * @intuition Provide performance metrics for monitoring
   * @approach Collect key metrics from player state
   * @complexity Time: O(1), Space: O(1)
   */
  getPlaybackStats() {
    return {
      currentBitrate: this.currentBitrate,
      networkQuality: this.networkQuality$.value,
      cacheSize: this.segmentCache.size,
      bufferedRanges: this.getBufferedRanges(),
      averageBandwidth: this.bandwidthEstimator.getCurrentBandwidth(),
      activeTracks: Object.fromEntries(this.activeTracks)
    }
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
