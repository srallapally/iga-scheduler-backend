from abc import ABC, abstractmethod


class SchedulerJob(ABC):
    @abstractmethod
    def execute(self, context):
        ...
