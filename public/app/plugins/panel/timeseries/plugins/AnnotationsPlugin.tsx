import { DataFrame, DataFrameView, dateTimeFormat, systemDateFormats, TimeZone } from '@grafana/data';
import { EventsCanvas, UPlotConfigBuilder, usePlotContext, useTheme } from '@grafana/ui';
import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { AnnotationMarker } from './AnnotationMarker';

interface AnnotationsPluginProps {
  config: UPlotConfigBuilder;
  annotations: DataFrame[];
  timeZone: TimeZone;
}

interface AnnotationsDataFrameViewDTO {
  time: number;
  text: string;
  tags: string[];
}

export const AnnotationsPlugin: React.FC<AnnotationsPluginProps> = ({ annotations, timeZone, config }) => {
  const theme = useTheme();
  const { getPlotInstance } = usePlotContext();

  const annotationsRef = useRef<Array<DataFrameView<AnnotationsDataFrameViewDTO>>>();

  const timeFormatter = useCallback(
    (value: number) => {
      return dateTimeFormat(value, {
        format: systemDateFormats.fullDate,
        timeZone,
      });
    },
    [timeZone]
  );

  // Update annotations views when new annotations came
  useEffect(() => {
    const views: Array<DataFrameView<AnnotationsDataFrameViewDTO>> = [];

    for (const frame of annotations) {
      views.push(new DataFrameView(frame));
    }

    annotationsRef.current = views;
  }, [annotations]);

  useLayoutEffect(() => {
    config.addHook('draw', (u) => {
      // Render annotation lines on the canvas
      /**
       * We cannot rely on state value here, as it would require this effect to be dependent on the state value.
       */
      if (!annotationsRef.current) {
        return null;
      }

      const ctx = u.ctx;
      if (!ctx) {
        return;
      }
      for (let i = 0; i < annotationsRef.current.length; i++) {
        const annotationsView = annotationsRef.current[i];
        for (let j = 0; j < annotationsView.length; j++) {
          const annotation = annotationsView.get(j);

          if (!annotation.time) {
            continue;
          }

          const xpos = u.valToPos(annotation.time, 'x', true);
          ctx.beginPath();
          ctx.lineWidth = 2;
          ctx.strokeStyle = theme.palette.red;
          ctx.setLineDash([5, 5]);
          ctx.moveTo(xpos, u.bbox.top);
          ctx.lineTo(xpos, u.bbox.top + u.bbox.height);
          ctx.stroke();
          ctx.closePath();
        }
      }
      return;
    });
  }, [config, theme]);

  const mapAnnotationToXYCoords = useCallback(
    (frame: DataFrame, index: number) => {
      const view = new DataFrameView<AnnotationsDataFrameViewDTO>(frame);
      const annotation = view.get(index);
      const plotInstance = getPlotInstance();
      if (!annotation.time || !plotInstance) {
        return undefined;
      }

      return {
        x: plotInstance.valToPos(annotation.time, 'x'),
        y: plotInstance.bbox.height / window.devicePixelRatio + 4,
      };
    },
    [getPlotInstance]
  );

  const renderMarker = useCallback(
    (frame: DataFrame, index: number) => {
      const view = new DataFrameView<AnnotationsDataFrameViewDTO>(frame);
      const annotation = view.get(index);
      return <AnnotationMarker time={timeFormatter(annotation.time)} text={annotation.text} tags={annotation.tags} />;
    },
    [timeFormatter]
  );

  return (
    <EventsCanvas
      id="annotations"
      config={config}
      events={annotations}
      renderEventMarker={renderMarker}
      mapEventToXYCoords={mapAnnotationToXYCoords}
    />
  );
};
